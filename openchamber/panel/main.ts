import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBanner,
  mountButton,
  mountList,
  mountMenu,
  mountSearchField,
  mountTabs,
  mountTextField,
  type ButtonHandle,
  type ListHandle,
  type TabsHandle,
  type TextFieldHandle,
} from '@openchamber/sdk/ui';
import type {
  AgentResponse,
  AgentVerb,
  ChatMessage,
  Claim,
  ClaimsResponse,
  EventsResponse,
  LoginResponse,
  Member,
  MessagesResponse,
  SendResponse,
  ServiceEvent,
  StateResponse,
  UnreadInfo,
} from '../shared/types.ts';
import { CSS } from './css.ts';
import {
  applyCompletion,
  awakeCount,
  completionCandidates,
  dayKey,
  fold,
  formatClock,
  formatDay,
  formatDuration,
  groupTargets,
  isLong,
  nickColor,
  sortMembers,
  splitMentions,
  wordBefore,
} from './util.ts';

// ---------------------------------------------------------------------------
// Host, API and small helpers
// ---------------------------------------------------------------------------

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

const errorText = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE') {
      return 'The local service is not running. Open Settings → Extensions, approve the local service for Agent Comms, and reload.';
    }
    if (error.code === 'SERVICE_FAILED') return 'The local service stopped. It restarts on the next request.';
    return `${error.code}: ${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
};

interface ApiResult<T> {
  status: number;
  data: T | null;
}

const api = async <T>(
  method: 'GET' | 'POST',
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<ApiResult<T>> => {
  const response = await host.serviceRequest({
    method,
    path,
    ...(options.query ? { query: options.query } : {}),
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  let data: T | null = null;
  try {
    data = JSON.parse(response.body) as T;
  } catch {
    data = null;
  }
  return { status: response.status, data };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toast = (kind: 'info' | 'success' | 'error', message: string): void => {
  void host.toast({ kind, message: message.slice(0, 400) }).catch(() => undefined);
};

const savePref = (key: string, value: string | boolean): void => {
  void host.storage.set(key, value).catch(() => undefined);
};

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

interface View {
  messages: ChatMessage[];
  seen: Set<number>;
  /** Live messages that arrived while the first page was loading. */
  pending: ChatMessage[];
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingOlder: boolean;
  error: string | null;
}

interface AgentResult {
  title: string;
  lines: string[];
  pending: boolean;
  error?: string;
}

const model = {
  state: null as StateResponse | null,
  offline: null as string | null,
  selected: null as string | null,
  views: new Map<string, View>(),
  unread: new Map<string, UnreadInfo>(),
  pendingDms: new Set<string>(),
  after: 0,
  epoch: '',
  dark: true,
  layout: 'wide' as 'wide' | 'narrow',
  compact: false,
  pane: 'list' as 'list' | 'chat' | 'members',
  rightOpen: true,
  rightTab: 'members' as 'members' | 'claims',
  showSystem: true,
  helpHidden: false,
  drafts: new Map<string, string>(),
  claims: null as Claim[] | null,
  claimsError: null as string | null,
  agentResult: null as AgentResult | null,
  newBelow: 0,
  sending: false,
  sendError: '',
  stickBottom: false,
  loginBusy: false,
  loginError: '',
  lastBadge: -1,
  /** True after the user picked a target, or a stored pick was loaded. */
  chosen: false,
};

const key = (target: string): string => fold(target);

const viewOf = (target: string): View => {
  let view = model.views.get(key(target));
  if (!view) {
    view = { messages: [], seen: new Set(), pending: [], hasMore: true, loaded: false, loading: false, loadingOlder: false, error: null };
    model.views.set(key(target), view);
  }
  return view;
};

const me = (): string => model.state?.nick ?? '';
const channelOf = (target: string | null) => model.state?.channels.find((c) => target !== null && fold(c.name) === fold(target)) ?? null;
const isChannel = (target: string | null): boolean => target !== null && /^[#&]/.test(target);

const allNicks = (): string[] => {
  const nicks = new Set<string>();
  for (const channel of model.state?.channels ?? []) for (const m of channel.members) nicks.add(m.nick);
  return [...nicks].filter((n) => fold(n) !== fold(me()));
};

const completionNicks = (): string[] => {
  const target = model.selected;
  if (target === null) return [];
  const channel = channelOf(target);
  const list = channel ? channel.members.map((m) => m.nick) : [target];
  return list.filter((n) => fold(n) !== fold(me()));
};

// ---------------------------------------------------------------------------
// DOM shell
// ---------------------------------------------------------------------------

const ui = {
  app: el('div', 'app'),
  banners: el('div', 'banners'),
  cols: el('div', 'cols'),
  side: el('aside', 'side'),
  sideHead: el('div', 'side-head'),
  sideList: el('div', 'side-list'),
  sideFoot: el('div', 'side-foot'),
  chat: el('main', 'chat'),
  chatHead: el('div', 'chat-head'),
  chatBody: el('div', 'chat-body'),
  msgs: el('div', 'msgs'),
  pill: el('button', 'pill'),
  blank: el('div', 'blank'),
  composer: el('div', 'composer'),
  input: el('textarea'),
  err: el('div', 'err'),
  quick: el('div', 'quick'),
  right: el('aside', 'right'),
  rightTabs: el('div', 'right-tabs'),
  rightBody: el('div', 'right-body'),
  setup: el('div', 'setup'),
};

let sendButton: ButtonHandle;
let rightTabsHandle: TabsHandle;
let setupPassword: TextFieldHandle;
let setupButton: ButtonHandle;
let setupError: HTMLElement;

// ---------------------------------------------------------------------------
// Rendering scheduler
// ---------------------------------------------------------------------------

type Part = 'banner' | 'side' | 'head' | 'msgs' | 'right' | 'composer' | 'setup' | 'layout';
const dirty = new Set<Part>();
let frame: ReturnType<typeof setTimeout> | 0 = 0;

// A timer, not requestAnimationFrame: a hidden panel does not get animation frames, but the badge must still update.
const schedule = (...parts: Part[]): void => {
  for (const part of parts) dirty.add(part);
  if (frame) return;
  frame = setTimeout(() => {
    frame = 0;
    const todo = new Set(dirty);
    dirty.clear();
    if (todo.has('layout')) renderLayout();
    if (todo.has('setup')) renderSetup();
    if (todo.has('banner')) renderBanners();
    if (todo.has('side')) renderSide();
    if (todo.has('head')) renderHead();
    if (todo.has('msgs')) syncMessages();
    if (todo.has('right')) renderRight();
    if (todo.has('composer')) renderComposer();
    updateBadge();
  }, 16);
};

const scheduleAll = (): void => schedule('layout', 'setup', 'banner', 'side', 'head', 'msgs', 'right', 'composer');

// ---------------------------------------------------------------------------
// Badge and read marks
// ---------------------------------------------------------------------------

const updateBadge = (): void => {
  let total = 0;
  for (const info of model.unread.values()) total += info.mentions;
  if (total === model.lastBadge) return;
  model.lastBadge = total;
  void host.setBadge(total > 0 ? total : null).catch(() => undefined);
};

const readTimers = new Map<string, ReturnType<typeof setTimeout>>();

const markRead = (target: string): void => {
  if (model.unread.delete(key(target))) schedule('side');
  const k = key(target);
  if (readTimers.has(k)) return;
  readTimers.set(
    k,
    setTimeout(() => {
      readTimers.delete(k);
      void api('POST', '/read', { body: { target, seq: model.after } }).catch(() => undefined);
    }, 300),
  );
};

const isAtBottom = (): boolean => ui.msgs.scrollHeight - ui.msgs.scrollTop - ui.msgs.clientHeight < 48;

const chatVisible = (): boolean =>
  document.visibilityState !== 'hidden' && (model.layout === 'wide' || model.pane === 'chat');

// ---------------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------------

const pickDefault = (): string | null => {
  const s = model.state;
  if (!s) return null;
  if (s.channels.some((c) => fold(c.name) === '#lobby')) return '#lobby';
  return s.channels[0]?.name ?? s.dms[0] ?? null;
};

const targetExists = (target: string): boolean => {
  const s = model.state;
  if (!s) return false;
  return (
    s.channels.some((c) => fold(c.name) === fold(target)) ||
    s.dms.some((d) => fold(d) === fold(target)) ||
    [...model.pendingDms].some((d) => fold(d) === fold(target))
  );
};

const applyState = (state: StateResponse): void => {
  const epochChanged = model.epoch !== '' && model.epoch !== state.epoch;
  model.state = state;
  model.epoch = state.epoch;
  model.after = state.seq;
  model.unread = new Map(Object.entries(state.unread).map(([name, info]) => [key(name), info]));
  for (const dm of state.dms) model.pendingDms.delete(dm);
  if (epochChanged) model.views.clear();
  // Before the user chooses, prefer #lobby as soon as it exists.
  const preferLobby = !model.chosen && model.selected !== null && fold(model.selected) !== '#lobby' && state.channels.some((c) => fold(c.name) === '#lobby');
  if (model.selected === null || !targetExists(model.selected) || preferLobby) {
    const next = pickDefault();
    if (next !== model.selected) {
      model.selected = next;
      if (next !== null) void loadTarget(next);
    }
  }
  scheduleAll();
};

const refreshState = async (): Promise<void> => {
  const { status, data } = await api<StateResponse>('GET', '/state');
  if (status !== 200 || !data) throw new Error(`Service returned HTTP ${status}`);
  model.offline = null;
  applyState(data);
};

const loadTarget = async (target: string, force = false): Promise<void> => {
  const view = viewOf(target);
  if ((view.loaded && !force) || view.loading) {
    schedule('msgs');
    return;
  }
  const first = !view.loaded;
  view.loading = true;
  view.error = null;
  schedule('msgs');
  try {
    const { status, data } = await api<MessagesResponse>('GET', '/messages', { query: { target, limit: '100' } });
    if (status !== 200 || !data) throw new Error(`Service returned HTTP ${status}`);
    view.messages = data.messages;
    view.seen = new Set(data.messages.map((m) => m.seq));
    // Events that came in while the page was on its way: keep those that the page does not hold.
    for (const m of view.pending) {
      if (view.seen.has(m.seq)) continue;
      view.seen.add(m.seq);
      view.messages.push(m);
    }
    view.pending = [];
    view.hasMore = data.hasMore;
    view.loaded = true;
    view.error = null;
  } catch (error) {
    view.error = errorText(error);
  } finally {
    view.loading = false;
    if (model.selected !== null && key(model.selected) === key(target)) {
      if (first) model.stickBottom = true;
      schedule('msgs');
    }
  }
};

const loadOlder = async (target: string): Promise<void> => {
  const view = viewOf(target);
  const first = view.messages[0];
  if (!view.loaded || view.loadingOlder || !view.hasMore || !first) return;
  view.loadingOlder = true;
  schedule('msgs');
  try {
    const { status, data } = await api<MessagesResponse>('GET', '/messages', {
      query: { target, before: String(first.seq), limit: '60' },
    });
    if (status !== 200 || !data) throw new Error(`Service returned HTTP ${status}`);
    const fresh = data.messages.filter((m) => !view.seen.has(m.seq));
    for (const m of fresh) view.seen.add(m.seq);
    view.messages = [...fresh, ...view.messages];
    view.hasMore = data.hasMore && fresh.length > 0;
  } catch (error) {
    view.error = errorText(error);
    view.hasMore = false;
  } finally {
    view.loadingOlder = false;
    if (model.selected !== null && key(model.selected) === key(target)) syncMessages({ anchor: true });
  }
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

let stateTimer: ReturnType<typeof setTimeout> | null = null;

const refreshSoon = (): void => {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    void refreshState().catch(() => undefined);
  }, 150);
};

const applyMessageEvent = (message: ChatMessage): void => {
  const k = key(message.target);
  const view = model.views.get(k);
  const selected = model.selected !== null && key(model.selected) === k;
  if (view?.loading) {
    view.pending.push(message);
  } else if (view?.loaded && !view.seen.has(message.seq)) {
    view.seen.add(message.seq);
    view.messages.push(message);
    if (view.messages.length > 1500 && (!selected || isAtBottom())) view.messages.splice(0, view.messages.length - 1200);
  }
  const chat = message.kind === 'privmsg' || message.kind === 'notice';
  if (!chat || message.self || message.history) {
    if (selected) schedule('msgs');
    return;
  }
  const active = selected && chatVisible() && isAtBottom();
  if (active) {
    markRead(message.target);
  } else {
    const info = model.unread.get(k) ?? { unread: 0, mentions: 0 };
    model.unread.set(k, { unread: info.unread + 1, mentions: info.mentions + (message.mention ? 1 : 0) });
    if (selected && chatVisible()) {
      model.newBelow += 1;
    }
    schedule('side');
  }
  if (selected) schedule('msgs');
};

const applyEvent = (event: ServiceEvent): void => {
  switch (event.type) {
    case 'message':
      applyMessageEvent(event.message);
      break;
    case 'members': {
      const channel = channelOf(event.channel);
      if (channel) channel.members = event.members;
      schedule('side', 'right', 'head', 'composer');
      break;
    }
    case 'topic': {
      const channel = channelOf(event.channel);
      if (channel) channel.topic = event.topic;
      schedule('head');
      break;
    }
    case 'channels':
      refreshSoon();
      break;
    case 'history': {
      const view = model.views.get(key(event.target));
      if (view && view.loaded && !view.loadingOlder) {
        // Backlog arrived after the view loaded. Load again from the start.
        if (model.selected !== null && key(model.selected) === key(event.target)) void loadTarget(event.target, true);
        else view.loaded = false;
      }
      break;
    }
    case 'connection': {
      if (model.state) {
        model.state.connected = event.connected;
        model.state.needsLogin = event.needsLogin;
        model.state.error = event.error;
      }
      if (event.connected) refreshSoon();
      schedule('banner', 'setup', 'composer', 'head');
      break;
    }
  }
};

const pollLoop = async (): Promise<void> => {
  let failures = 0;
  for (;;) {
    try {
      if (model.state === null) {
        await refreshState();
        if (model.selected !== null) void loadTarget(model.selected);
      }
      const { status, data } = await api<EventsResponse>('GET', '/events', {
        query: { after: String(model.after), wait: '15000', epoch: model.epoch },
      });
      if (status !== 200 || !data) throw new Error(`Service returned HTTP ${status}`);
      failures = 0;
      if (model.offline !== null) {
        model.offline = null;
        schedule('banner');
      }
      if (data.reset) {
        model.views.clear();
        await refreshState();
        if (model.selected !== null) void loadTarget(model.selected);
        continue;
      }
      model.after = data.seq;
      for (const event of data.events) applyEvent(event);
    } catch (error) {
      failures += 1;
      model.offline = errorText(error);
      schedule('banner');
      await sleep(Math.min(10_000, 1000 * failures));
    }
  }
};

// ---------------------------------------------------------------------------
// Rendering: layout, banners, setup
// ---------------------------------------------------------------------------

const renderLayout = (): void => {
  ui.app.dataset.layout = model.layout;
  ui.app.dataset.pane = model.pane;
  ui.app.dataset.right = model.rightOpen ? 'open' : 'closed';
  if (model.compact) ui.app.dataset.compact = 'true';
  else delete ui.app.dataset.compact;
};

const renderBanners = (): void => {
  ui.banners.replaceChildren();
  const s = model.state;
  if (model.offline !== null) {
    mountBanner(ui.banners, { tone: 'error', title: 'Cannot reach the Agent Comms service', body: model.offline });
    return;
  }
  if (s && !s.needsLogin && !s.connected) {
    mountBanner(ui.banners, {
      tone: 'warning',
      title: 'Disconnected from the IRC server. Retrying…',
      ...(s.error ? { body: s.error } : {}),
    });
  }
};

const renderSetup = (): void => {
  const s = model.state;
  const show = s !== null && s.needsLogin && model.offline === null;
  ui.setup.hidden = !show;
  if (!show) return;
  setupButton.update({ loading: model.loginBusy, disabled: model.loginBusy });
  setupPassword.update({ disabled: model.loginBusy });
  const message = model.loginError || s?.error || '';
  setupError.textContent = message;
};

const buildSetup = (): void => {
  const card = el('div', 'setup-card');
  card.append(
    el('h2', '', 'Connect to agent-comms'),
    el(
      'p',
      '',
      'Enter the operator password of your agent-comms server. It is the password that "agent-comms install" printed. The extension keeps it in a private file on this computer (mode 0600) and never shows it again.',
    ),
  );
  const fieldRoot = el('div');
  card.append(fieldRoot);
  let password = '';
  setupPassword = mountTextField(fieldRoot, {
    label: 'Operator password',
    password: true,
    value: '',
    onChange: (value) => {
      password = value;
      setupPassword.update({ value });
    },
  });
  setupError = el('div', 'err');
  const actions = el('div', 'actions');
  const submit = async (): Promise<void> => {
    if (model.loginBusy || password === '') return;
    model.loginBusy = true;
    model.loginError = '';
    schedule('setup');
    try {
      const { data } = await api<LoginResponse>('POST', '/login', { body: { password } });
      if (data?.ok) {
        password = '';
        setupPassword.update({ value: '' });
        model.loginError = '';
        await refreshState();
        if (model.selected !== null) void loadTarget(model.selected, true);
      } else {
        model.loginError = data?.error ?? 'Login failed';
      }
    } catch (error) {
      model.loginError = errorText(error);
    } finally {
      model.loginBusy = false;
      scheduleAll();
    }
  };
  setupButton = mountButton(actions, { label: 'Connect', onClick: () => void submit() });
  card.append(setupError, actions);
  ui.setup.append(card);
  ui.setup.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submit();
    }
  });
};

// ---------------------------------------------------------------------------
// Rendering: sidebar
// ---------------------------------------------------------------------------

let closePopover: (() => void) | null = null;

const closeFloating = (): void => {
  closePopover?.();
  closePopover = null;
  document.querySelectorAll('.popmenu').forEach((node) => node.remove());
};

const selectTarget = (target: string): void => {
  closeFloating();
  if (model.selected !== null) model.drafts.set(key(model.selected), ui.input.value);
  model.selected = target;
  model.chosen = true;
  model.pane = 'chat';
  model.newBelow = 0;
  model.sendError = '';
  ui.input.value = model.drafts.get(key(target)) ?? '';
  resizeInput();
  savePref('selected', target);
  model.stickBottom = true;
  void loadTarget(target);
  markRead(target);
  scheduleAll();
  if (model.layout === 'wide') ui.input.focus();
};

const openDm = (nick: string): void => {
  if (fold(nick) === fold(me())) {
    toast('info', 'That is your own nick.');
    return;
  }
  if (!targetExists(nick)) model.pendingDms.add(nick);
  void api('POST', '/dm', { body: { nick } }).catch(() => undefined);
  selectTarget(nick);
};

const openNewDmPopover = (): void => {
  closeFloating();
  const pop = el('div', 'popover');
  const searchRoot = el('div');
  const listRoot = el('div', 'list');
  pop.append(searchRoot, listRoot);
  ui.side.append(pop);
  let query = '';
  let list: ListHandle;
  const refresh = (): void => {
    const q = query.trim().toLowerCase();
    const known = allNicks().filter((n) => q === '' || n.toLowerCase().includes(q));
    const items = known.slice(0, 60).map((n) => ({ id: n, title: n }));
    const typed = query.trim();
    if (typed !== '' && !known.some((n) => fold(n) === fold(typed)) && !/[\s,#&:]/.test(typed)) {
      items.unshift({ id: typed, title: `Message “${typed}”` });
    }
    list.update({ items });
  };
  const search = mountSearchField(searchRoot, {
    value: '',
    placeholder: 'Find a nick…',
    autofocus: true,
    onChange: (value) => {
      query = value;
      search.update({ value });
      refresh();
    },
  });
  list = mountList(listRoot, {
    items: [],
    emptyText: 'No matching nick',
    ariaLabel: 'Nicks',
    onSelect: (id) => {
      closeFloating();
      openDm(id);
    },
  });
  refresh();
  closePopover = () => pop.remove();
};

const renderSide = (): void => {
  const s = model.state;
  ui.sideList.replaceChildren();
  if (!s) return;
  const sections = groupTargets(s.channels, [...new Set([...s.dms, ...model.pendingDms])], model.unread, s.nick);
  for (const section of sections) {
    const head = el('div', 'sec-head');
    head.append(el('span', '', section.title));
    if (section.id === 'dms') {
      const add = el('button', 'icon-btn', '+');
      add.title = 'New direct message';
      add.setAttribute('aria-label', 'New direct message');
      add.addEventListener('click', (event) => {
        event.stopPropagation();
        openNewDmPopover();
      });
      head.append(add);
    }
    ui.sideList.append(head);
    if (section.items.length === 0) {
      ui.sideList.append(el('div', 'empty-note', 'No direct messages yet.'));
      continue;
    }
    for (const item of section.items) {
      const row = el('button', 'row');
      const current = model.selected !== null && fold(model.selected) === fold(item.target);
      row.setAttribute('aria-current', current ? 'true' : 'false');
      if (item.unread > 0) row.classList.add('unread');
      if (item.kind === 'dm') row.append(el('span', 'dot busy'));
      row.append(el('span', 'name', item.label));
      if (item.awake !== null && item.awake > 0) {
        const awake = el('span', 'awake');
        awake.title = `${item.awake} awake agent${item.awake === 1 ? '' : 's'}`;
        awake.append(el('span', 'dot'), document.createTextNode(String(item.awake)));
        row.append(awake);
      }
      if (item.unread > 0) {
        const count = el('span', item.mentions > 0 ? 'count mention' : 'count', item.unread > 99 ? '99+' : String(item.unread));
        count.title = item.mentions > 0 ? `${item.mentions} for you` : 'Unread messages';
        row.append(count);
      }
      row.addEventListener('click', () => selectTarget(item.target));
      ui.sideList.append(row);
    }
  }
  ui.sideFoot.hidden = model.helpHidden;
};

const buildSideChrome = (): void => {
  const title = el('h1', '', 'Agent Comms');
  ui.sideHead.append(title);
  const status = el('span', 'dot');
  status.id = 'conn-dot';
  ui.sideHead.append(status);
  const menuRoot = el('div');
  ui.sideHead.append(menuRoot);
  const menu = mountMenu(menuRoot, {
    label: '⋯',
    variant: 'ghost',
    size: 'xs',
    items: [
      { id: 'system', label: 'Hide joins and away lines' },
      { id: 'help', label: 'Hide help note' },
      { separator: true },
      { id: 'logout', label: 'Log out of agent-comms', destructive: true },
    ],
    onSelect: (id) => {
      if (id === 'help') {
        model.helpHidden = !model.helpHidden;
        savePref('helpHidden', model.helpHidden);
      } else if (id === 'system') {
        model.showSystem = !model.showSystem;
        savePref('showSystem', model.showSystem);
        model.stickBottom = false;
        schedule('msgs');
      } else if (id === 'logout') {
        void api('POST', '/logout').then(() => refreshState()).catch((error: unknown) => toast('error', errorText(error)));
      }
      menu.update({
        items: [
          { id: 'system', label: model.showSystem ? 'Hide joins and away lines' : 'Show joins and away lines' },
          { id: 'help', label: model.helpHidden ? 'Show help note' : 'Hide help note' },
          { separator: true },
          { id: 'logout', label: 'Log out of agent-comms', destructive: true },
        ],
      });
      schedule('side');
    },
  });
  ui.sideFoot.append(
    el('p', '', 'You see every channel, all agent traffic in them, and direct messages sent to you.'),
    el('p', '', 'Direct messages between agents are private. The server does not show them.'),
    el('p', '', 'Use @here for awake members. Use @all to wake every member.'),
  );
  ui.side.append(ui.sideHead, ui.sideList, ui.sideFoot);
};

// ---------------------------------------------------------------------------
// Rendering: chat header and messages
// ---------------------------------------------------------------------------

let headTitle: HTMLElement;
let headSub: HTMLElement;
let backButton: HTMLButtonElement;
let statusButton: HTMLButtonElement;
let membersButton: HTMLButtonElement;

const buildHead = (): void => {
  backButton = el('button', 'head-btn', '‹ Channels');
  backButton.addEventListener('click', () => {
    model.pane = 'list';
    schedule('layout');
  });
  const title = el('div', 'chat-title');
  headTitle = el('b');
  headSub = el('small');
  title.append(headTitle, headSub);
  statusButton = el('button', 'head-btn', 'Status');
  statusButton.title = 'Ask every agent in this channel for its status';
  statusButton.addEventListener('click', () => {
    if (model.selected !== null) void runAgent('STATUS', model.selected);
  });
  membersButton = el('button', 'head-btn', 'Members');
  membersButton.addEventListener('click', () => {
    if (model.layout === 'narrow') {
      model.pane = 'members';
    } else {
      model.rightOpen = !model.rightOpen;
      savePref('rightOpen', model.rightOpen);
    }
    schedule('layout', 'head', 'right');
    if (model.rightOpen || model.layout === 'narrow') void loadClaimsIfVisible();
  });
  ui.chatHead.append(backButton, title, statusButton, membersButton);
};

const renderHead = (): void => {
  const target = model.selected;
  const s = model.state;
  backButton.hidden = model.layout !== 'narrow';
  const dot = document.getElementById('conn-dot');
  if (dot) {
    dot.className = `dot ${s && s.connected ? 'busy' : 'off'}`;
    dot.title = s && s.connected ? 'Connected' : 'Disconnected';
  }
  if (target === null) {
    headTitle.textContent = 'Agent Comms';
    headSub.textContent = s?.connected ? 'No channel selected' : '';
    statusButton.hidden = true;
    membersButton.hidden = true;
    return;
  }
  const channel = channelOf(target);
  headTitle.textContent = channel ? channel.name : target;
  if (channel) {
    const awake = awakeCount(channel.members, me());
    const agents = channel.members.filter((m) => !m.operator && fold(m.nick) !== fold(me())).length;
    const bits = [`${awake} awake of ${agents} agent${agents === 1 ? '' : 's'}`];
    if (channel.topic) bits.push(channel.topic);
    headSub.textContent = bits.join(' · ');
  } else {
    const partner = channelOf('#lobby')?.members.find((m) => fold(m.nick) === fold(target)) ??
      model.state?.channels.flatMap((c) => c.members).find((m) => fold(m.nick) === fold(target));
    headSub.textContent = partner ? (partner.away === null ? 'busy' : partner.away) : 'Direct message';
  }
  statusButton.hidden = !channel;
  membersButton.hidden = !channel && model.layout !== 'narrow';
  membersButton.textContent = model.layout === 'narrow' ? 'Members' : model.rightOpen ? 'Hide members' : 'Members';
  if (!channel && model.layout === 'narrow') membersButton.hidden = true;
};

interface Rendered {
  target: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
}

let rendered: Rendered | null = null;

const visibleMessages = (view: View): ChatMessage[] =>
  model.showSystem ? view.messages : view.messages.filter((m) => m.kind === 'privmsg' || m.kind === 'notice');

const isChat = (m: ChatMessage): boolean => m.kind === 'privmsg' || m.kind === 'notice';

const appendMentions = (parent: HTMLElement, text: string): void => {
  for (const part of splitMentions(text, me())) {
    if (part.kind === 'text') {
      parent.append(document.createTextNode(part.text));
    } else {
      const mark = el('mark', part.kind === 'me' ? 'me' : 'bc', part.text);
      parent.append(mark);
    }
  }
};

const buildMessage = (m: ChatMessage, prev: ChatMessage | undefined): DocumentFragment => {
  const frag = document.createDocumentFragment();
  if (!prev || dayKey(prev.time) !== dayKey(m.time)) frag.append(el('div', 'day', formatDay(m.time)));
  if (!isChat(m)) {
    const line = el('div', 'sys');
    line.append(document.createTextNode(`${formatClock(m.time)} · `));
    if (m.kind === 'topic') {
      line.append(document.createTextNode(`${m.from} ${m.text}`));
    } else {
      const nick = el('span', '', m.from);
      nick.style.color = nickColor(m.from, model.dark);
      line.append(nick, document.createTextNode(` ${m.text}`));
    }
    frag.append(line);
    return frag;
  }
  const grouped =
    prev !== undefined &&
    isChat(prev) &&
    prev.from === m.from &&
    prev.kind === m.kind &&
    dayKey(prev.time) === dayKey(m.time) &&
    m.time - prev.time < 5 * 60_000 &&
    prev.broadcast === m.broadcast;
  const row = el('div', 'msg');
  if (!grouped) row.classList.add('first');
  if (m.mention) row.classList.add('mention');
  row.title = new Date(m.time).toLocaleString();
  if (!grouped) {
    const head = el('div', 'mh');
    head.append(el('span', 'time', formatClock(m.time)));
    const nick = el('span', 'nick', m.from);
    nick.style.color = nickColor(m.from, model.dark);
    head.append(nick);
    if (m.role === 'operator') head.append(el('span', 'tag op', 'operator'));
    if (m.broadcast) head.append(el('span', 'tag bc', `@${m.broadcast}`));
    if (m.kind === 'notice') head.append(el('span', 'tag', 'notice'));
    row.append(head);
  }
  const body = el('div', m.kind === 'notice' ? 'mb notice' : 'mb');
  appendMentions(body, m.text);
  row.append(body);
  if (isLong(m.text)) {
    row.classList.add('clamp');
    const more = el('button', 'more', 'Show more');
    more.addEventListener('click', () => {
      const open = row.classList.toggle('clamp');
      more.textContent = open ? 'Show more' : 'Show less';
    });
    row.append(more);
  }
  frag.append(row);
  return frag;
};

const scrollToBottom = (): void => {
  ui.msgs.scrollTop = ui.msgs.scrollHeight;
};

const syncMessages = (options: { anchor?: boolean } = {}): void => {
  const target = model.selected;
  const s = model.state;
  ui.blank.hidden = true;
  ui.msgs.hidden = false;
  if (target === null || !s || s.needsLogin) {
    ui.msgs.replaceChildren();
    rendered = null;
    ui.blank.hidden = false;
    ui.msgs.hidden = true;
    ui.blank.textContent = s && !s.needsLogin ? (s.connected ? 'Select a channel to start.' : 'Waiting for the IRC server…') : 'Loading…';
    ui.pill.hidden = true;
    return;
  }
  const view = viewOf(target);
  const list = visibleMessages(view);
  const wasBottom = isAtBottom();
  const canAppend =
    rendered !== null &&
    rendered.target === key(target) &&
    rendered.count > 0 &&
    list.length >= rendered.count &&
    list[0]?.seq === rendered.firstSeq &&
    list[rendered.count - 1]?.seq === rendered.lastSeq &&
    !options.anchor &&
    ui.msgs.dataset.notes === noteState(view);
  if (canAppend && rendered) {
    if (list.length > rendered.count) {
      const frag = document.createDocumentFragment();
      for (let i = rendered.count; i < list.length; i += 1) frag.append(buildMessage(list[i]!, list[i - 1]));
      ui.msgs.append(frag);
    }
  } else {
    const distanceFromBottom = ui.msgs.scrollHeight - ui.msgs.scrollTop;
    const sameTarget = rendered?.target === key(target);
    ui.msgs.replaceChildren();
    ui.msgs.dataset.notes = noteState(view);
    if (view.loadingOlder) ui.msgs.append(el('div', 'loading-note', 'Loading older messages…'));
    else if (view.loaded && !view.hasMore && list.length > 0) ui.msgs.append(el('div', 'loading-note', 'Start of history'));
    if (view.loading && !view.loaded) ui.msgs.append(el('div', 'loading-note', 'Loading messages…'));
    if (view.error) ui.msgs.append(el('div', 'loading-note err', view.error));
    if (view.loaded && list.length === 0 && !view.loading) ui.msgs.append(el('div', 'loading-note', 'No messages yet.'));
    const frag = document.createDocumentFragment();
    list.forEach((m, i) => frag.append(buildMessage(m, list[i - 1])));
    ui.msgs.append(frag);
    if (options.anchor && sameTarget) {
      ui.msgs.scrollTop = ui.msgs.scrollHeight - distanceFromBottom;
    } else if (!sameTarget || model.stickBottom || wasBottom) {
      scrollToBottom();
    }
  }
  const last = list[list.length - 1];
  rendered = {
    target: key(target),
    count: list.length,
    firstSeq: list[0]?.seq ?? 0,
    lastSeq: last?.seq ?? 0,
  };
  if (model.stickBottom || (wasBottom && canAppend)) {
    scrollToBottom();
    model.newBelow = 0;
    if (view.loaded) markRead(target);
  }
  if (view.loaded) model.stickBottom = false;
  ui.pill.hidden = model.newBelow === 0 || isAtBottom();
  if (!ui.pill.hidden) ui.pill.textContent = `${model.newBelow} new message${model.newBelow === 1 ? '' : 's'} ↓`;
  else model.newBelow = 0;
  // Too few messages to fill the view: there is no scroll event, so ask for older ones now.
  if (view.loaded && view.hasMore && !view.loadingOlder && ui.msgs.scrollHeight <= ui.msgs.clientHeight + 4) {
    queueMicrotask(() => void loadOlder(target));
  }
};

const noteState = (view: View): string => `${view.loadingOlder}|${view.hasMore}|${view.loading}|${view.loaded}|${view.error ?? ''}|${model.showSystem}`;

const onScroll = (): void => {
  const target = model.selected;
  if (target === null) return;
  if (isAtBottom()) {
    if (model.newBelow > 0) {
      model.newBelow = 0;
      ui.pill.hidden = true;
    }
    if (model.unread.has(key(target)) && chatVisible()) markRead(target);
  }
  if (ui.msgs.scrollTop < 80) void loadOlder(target);
};

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

let completion: { base: string; start: number; wordEnd: number; index: number; candidates: string[]; caret: number } | null = null;

const resizeInput = (): void => {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(180, Math.max(38, ui.input.scrollHeight))}px`;
};

const insertAtCaret = (text: string): void => {
  const start = ui.input.selectionStart;
  const end = ui.input.selectionEnd;
  const before = ui.input.value.slice(0, start);
  const needsSpace = before !== '' && !/\s$/.test(before);
  const insert = `${needsSpace ? ' ' : ''}${text} `;
  ui.input.setRangeText(insert, start, end, 'end');
  ui.input.focus();
  resizeInput();
};

let toLabel: HTMLElement;
let hereChip: HTMLButtonElement;
let allChip: HTMLButtonElement;

const buildComposer = (): void => {
  ui.input.rows = 1;
  ui.input.placeholder = 'Message…';
  ui.input.setAttribute('aria-label', 'Message');
  ui.input.addEventListener('input', () => {
    completion = null;
    resizeInput();
    renderComposer();
  });
  ui.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void sendMessage();
      return;
    }
    if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const caret = ui.input.selectionStart;
      if (completion && caret === completion.caret) {
        // Tab again: the next candidate replaces the last one.
        event.preventDefault();
        completion.index = (completion.index + 1) % completion.candidates.length;
        applyCandidate(completion);
        return;
      }
      const { start, word } = wordBefore(ui.input.value, caret);
      const candidates = completionCandidates(word, completionNicks());
      if (candidates.length === 0) return;
      event.preventDefault();
      completion = { base: ui.input.value, start, wordEnd: caret, index: 0, candidates, caret };
      applyCandidate(completion);
    }
  });
  const row = el('div', 'composer-row');
  const sendRoot = el('div');
  row.append(ui.input, sendRoot);
  sendButton = mountButton(sendRoot, { label: 'Send', onClick: () => void sendMessage() });
  toLabel = el('span', 'to');
  hereChip = el('button', 'chip', '@here');
  hereChip.title = 'Reach the awake members of this channel';
  hereChip.addEventListener('click', () => insertAtCaret('@here'));
  allChip = el('button', 'chip warn', '@all');
  allChip.title = 'Wake every member of this channel (operator only)';
  allChip.addEventListener('click', () => insertAtCaret('@all'));
  ui.quick.append(toLabel, hereChip, allChip);
  ui.composer.append(ui.err, row, ui.quick);
};

/** Put the current candidate into the text. It always starts from the text before the first Tab. */
const applyCandidate = (c: NonNullable<typeof completion>): void => {
  const done = applyCompletion(c.base, c.start, c.wordEnd, c.candidates[c.index]!);
  ui.input.value = done.text;
  ui.input.setSelectionRange(done.caret, done.caret);
  c.caret = done.caret;
  resizeInput();
};

const renderComposer = (): void => {
  const target = model.selected;
  const s = model.state;
  const ready = target !== null && s !== null && s.connected && !s.needsLogin;
  ui.input.disabled = !ready || model.sending;
  const channel = isChannel(target);
  const where = target === null ? '' : channel ? `To ${target}` : `Direct message to ${target}`;
  toLabel.textContent = where === '' ? '' : `${where} · Enter sends · Shift+Enter adds a line · Tab completes a nick`;
  toLabel.title = toLabel.textContent;
  hereChip.hidden = !channel;
  allChip.hidden = !channel;
  sendButton.update({ disabled: !ready || model.sending || ui.input.value.trim() === '', loading: model.sending });
  ui.err.textContent = model.sendError;
};

const sendMessage = async (): Promise<void> => {
  const target = model.selected;
  const text = ui.input.value;
  if (target === null || model.sending || text.trim() === '') return;
  model.sending = true;
  model.sendError = '';
  renderComposer();
  try {
    const { data } = await api<SendResponse>('POST', '/send', { body: { target, text } });
    if (data?.ok) {
      if (model.selected !== null && key(model.selected) === key(target)) {
        ui.input.value = '';
        resizeInput();
      }
      model.drafts.delete(key(target));
      model.stickBottom = true;
    } else {
      model.sendError = data?.error ?? 'The message was not sent.';
    }
  } catch (error) {
    model.sendError = errorText(error);
  } finally {
    model.sending = false;
    renderComposer();
    if (model.layout === 'wide') ui.input.focus();
  }
};

// ---------------------------------------------------------------------------
// Right column: members and claims
// ---------------------------------------------------------------------------

const runAgent = async (verb: AgentVerb, target: string): Promise<void> => {
  model.agentResult = { title: `${verb} ${target}`, lines: [], pending: true };
  if (model.layout === 'wide' && !model.rightOpen) {
    model.rightOpen = true;
    savePref('rightOpen', true);
  }
  model.rightTab = 'members';
  schedule('right', 'layout', 'head');
  try {
    const { data } = await api<AgentResponse>('POST', '/agent', { body: { verb, target } });
    const result: AgentResult = {
      title: `${verb} ${target}`,
      lines: data?.lines ?? [],
      pending: false,
      ...(data && !data.ok ? { error: data.error ?? 'The request failed.' } : {}),
    };
    model.agentResult = result;
    const summary = result.error ? `${result.title}: ${result.error}` : result.lines.length > 0 ? result.lines.join(' · ') : `${result.title}: no answer`;
    toast(result.error ? 'error' : 'info', summary);
  } catch (error) {
    model.agentResult = { title: `${verb} ${target}`, lines: [], pending: false, error: errorText(error) };
    toast('error', errorText(error));
  }
  schedule('right');
};

const openMemberMenu = (anchor: HTMLElement, member: Member): void => {
  closeFloating();
  const menu = el('div', 'popmenu');
  const add = (label: string, run: () => void, danger = false): void => {
    const button = el('button', danger ? 'danger' : '', label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      closeFloating();
      run();
    });
    menu.append(button);
  };
  add('Send a message', () => openDm(member.nick));
  if (!member.operator) {
    add('Agent status', () => void runAgent('STATUS', member.nick));
    add('Interrupt', () => void runAgent('INTERRUPT', member.nick), true);
    add('Resume', () => void runAgent('RESUME', member.nick));
  }
  ui.rightBody.append(menu);
  const bounds = anchor.getBoundingClientRect();
  const parent = ui.rightBody.getBoundingClientRect();
  const top = bounds.bottom - parent.top + ui.rightBody.scrollTop;
  menu.style.top = `${Math.max(0, Math.min(top, ui.rightBody.scrollHeight - 150))}px`;
  menu.style.right = '10px';
};

const claimsTimerMs = 15_000;
let claimsTimer: ReturnType<typeof setInterval> | null = null;

const loadClaims = async (): Promise<void> => {
  try {
    const { data } = await api<ClaimsResponse>('GET', '/claims');
    if (data?.ok) {
      model.claims = data.claims;
      model.claimsError = null;
    } else {
      model.claimsError = data?.error ?? 'Could not read the claims.';
    }
  } catch (error) {
    model.claimsError = errorText(error);
  }
  schedule('right');
};

const rightVisible = (): boolean =>
  document.visibilityState !== 'hidden' && (model.layout === 'narrow' ? model.pane === 'members' : model.rightOpen);

const loadClaimsIfVisible = async (): Promise<void> => {
  if (model.rightTab === 'claims' && rightVisible()) await loadClaims();
};

const renderRight = (): void => {
  const s = model.state;
  const target = model.selected;
  const channel = channelOf(target);
  rightTabsHandle.update({
    activeId: model.rightTab,
    items: [
      { id: 'members', label: 'Members', ...(channel ? { count: channel.members.length } : {}) },
      { id: 'claims', label: 'Claims', ...(model.claims ? { count: model.claims.length } : {}) },
    ],
  });
  const body = ui.rightBody;
  const scroll = body.scrollTop;
  body.replaceChildren();
  if (model.agentResult) {
    const box = el('div', 'result');
    const result = model.agentResult;
    box.append(el('b', '', result.title));
    if (result.pending) box.append(el('pre', '', 'Waiting for the answer…'));
    else if (result.error) box.append(el('pre', '', result.error));
    else box.append(el('pre', '', result.lines.length > 0 ? result.lines.join('\n') : 'No answer.'));
    const close = el('button', 'icon-btn x', '×');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => {
      model.agentResult = null;
      schedule('right');
    });
    box.append(close);
    body.append(box);
  }
  if (model.rightTab === 'claims') {
    if (model.claimsError) body.append(el('div', 'empty-note', model.claimsError));
    else if (!model.claims) body.append(el('div', 'empty-note', 'Loading claims…'));
    else if (model.claims.length === 0) body.append(el('div', 'empty-note', 'No file claims right now.'));
    const now = Date.now() / 1000;
    for (const claim of model.claims ?? []) {
      const row = el('div', 'claim');
      const nick = el('b', '', claim.nick);
      nick.style.color = nickColor(claim.nick, model.dark);
      row.append(nick, el('div', 'path', claim.path), el('div', 'meta', `for ${formatDuration(now - claim.since)}, expires in ${formatDuration(claim.until - now)}`));
      body.append(row);
    }
    body.scrollTop = scroll;
    return;
  }
  if (!s || !channel) {
    body.append(el('div', 'empty-note', target === null ? 'Select a channel to see its members.' : 'Direct messages have no member list.'));
    return;
  }
  for (const member of sortMembers(channel.members)) {
    const row = el('div', `member ${member.away ?? 'busy'}`);
    row.append(el('span', `dot ${member.away ?? 'busy'}`));
    row.append(el('span', 'name', member.nick));
    row.title = `${member.nick} · ${member.away ?? 'busy'}${member.operator ? ' · human operator' : ''}`;
    if (member.operator) row.append(el('span', 'sub', 'human'));
    else if (member.away !== null) row.append(el('span', 'sub', member.away));
    const more = el('button', 'icon-btn', '⋯');
    more.setAttribute('aria-label', `Actions for ${member.nick}`);
    more.addEventListener('click', (event) => {
      event.stopPropagation();
      openMemberMenu(more, member);
    });
    row.append(more);
    row.addEventListener('click', () => {
      if (fold(member.nick) !== fold(s.nick)) openDm(member.nick);
    });
    body.append(row);
  }
  body.scrollTop = scroll;
};

const buildRight = (): void => {
  const tabsRoot = el('div');
  ui.rightTabs.append(tabsRoot);
  rightTabsHandle = mountTabs(tabsRoot, {
    items: [
      { id: 'members', label: 'Members' },
      { id: 'claims', label: 'Claims' },
    ],
    activeId: 'members',
    onChange: (id) => {
      model.rightTab = id === 'claims' ? 'claims' : 'members';
      schedule('right');
      void loadClaimsIfVisible();
    },
  });
  const refresh = el('button', 'icon-btn', '↻');
  refresh.title = 'Refresh claims';
  refresh.addEventListener('click', () => {
    if (model.rightTab === 'claims') void loadClaims();
    else void refreshState().catch(() => undefined);
  });
  const close = el('button', 'icon-btn', '×');
  close.title = 'Close';
  close.addEventListener('click', () => {
    if (model.layout === 'narrow') model.pane = 'chat';
    else {
      model.rightOpen = false;
      savePref('rightOpen', false);
    }
    schedule('layout', 'head');
  });
  ui.rightTabs.append(refresh, close);
  ui.right.append(ui.rightTabs, ui.rightBody);
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const build = (): void => {
  const style = el('style', '', CSS);
  document.head.append(style);
  buildSideChrome();
  buildHead();
  buildComposer();
  buildRight();
  buildSetup();
  ui.pill.hidden = true;
  ui.pill.addEventListener('click', () => {
    model.newBelow = 0;
    scrollToBottom();
    ui.pill.hidden = true;
    if (model.selected !== null) markRead(model.selected);
  });
  ui.msgs.addEventListener('scroll', onScroll, { passive: true });
  ui.chatBody.append(ui.msgs, ui.blank, ui.pill);
  ui.chat.append(ui.chatHead, ui.chatBody, ui.composer);
  ui.cols.append(ui.side, ui.chat, ui.right);
  ui.app.append(ui.banners, ui.cols, ui.setup);
  root.replaceChildren(ui.app);
  document.addEventListener('click', (event) => {
    const target = event.target as Node | null;
    if (target && (ui.side.querySelector('.popover')?.contains(target) || target instanceof Element && target.closest('.popmenu'))) return;
    closeFloating();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeFloating();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && model.selected !== null && isAtBottom()) markRead(model.selected);
    if (document.visibilityState === 'visible') void loadClaimsIfVisible();
  });
  const measure = (): void => {
    const width = ui.app.clientWidth;
    const layout = width < 700 ? 'narrow' : 'wide';
    const compact = layout === 'wide' && width < 960;
    if (layout !== model.layout || compact !== model.compact) {
      // In a compact width the members column covers the chat. Start with it closed.
      if (compact && !model.compact) model.rightOpen = false;
      model.layout = layout;
      model.compact = compact;
      if (layout === 'wide') model.pane = 'chat';
      scheduleAll();
    }
  };
  new ResizeObserver(measure).observe(ui.app);
  measure();
  claimsTimer = setInterval(() => void loadClaimsIfVisible(), claimsTimerMs);
  void claimsTimer;
  renderLayout();
  scheduleAll();
};

const loadPrefs = async (): Promise<void> => {
  try {
    const [rightOpen, showSystem, helpHidden, selected] = await Promise.all([
      host.storage.get('rightOpen'),
      host.storage.get('showSystem'),
      host.storage.get('helpHidden'),
      host.storage.get('selected'),
    ]);
    if (typeof rightOpen === 'boolean') model.rightOpen = rightOpen;
    if (typeof showSystem === 'boolean') model.showSystem = showSystem;
    if (typeof helpHidden === 'boolean') model.helpHidden = helpHidden;
    if (typeof selected === 'string') {
      model.selected = selected;
      model.chosen = true;
    }
  } catch {
    // Preferences are optional.
  }
};

let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  const dark = context.theme.mode === 'dark';
  if (mounted) {
    if (dark !== model.dark) {
      model.dark = dark;
      rendered = null;
      scheduleAll();
    }
    return;
  }
  mounted = true;
  model.dark = dark;
  void loadPrefs().then(() => {
    build();
    void pollLoop();
  });
});
