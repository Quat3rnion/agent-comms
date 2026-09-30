export const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.45}
button{font:inherit;color:inherit}
.app{height:100%;display:flex;flex-direction:column;position:relative;background:var(--oc-bg)}
.banners{flex:none;display:flex;flex-direction:column;gap:6px;padding:6px 8px 0}
.banners:empty{display:none}
.cols{flex:1;min-height:0;display:grid;grid-template-columns:100%;position:relative}
.app[data-layout=wide] .cols{grid-template-columns:var(--side-w,220px) minmax(0,1fr) 0}
.app[data-layout=wide][data-right=open]:not([data-compact]) .cols{grid-template-columns:var(--side-w,220px) minmax(0,1fr) 230px}
.app[data-layout=wide][data-compact] .cols{--side-w:190px}
.app[data-layout=narrow] .side,.app[data-layout=narrow] .chat,.app[data-layout=narrow] .right{display:none}
.app[data-layout=narrow][data-pane=list] .side{display:flex}
.app[data-layout=narrow][data-pane=chat] .chat{display:flex}
.app[data-layout=narrow][data-pane=members] .right{display:flex}

.side,.right{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--oc-elevated);overflow:hidden}
.side{border-right:1px solid var(--oc-border)}
.right{border-left:1px solid var(--oc-border)}
.app[data-layout=wide] .right{display:none}
.app[data-layout=wide][data-right=open] .right{display:flex}
.app[data-layout=wide][data-compact][data-right=open] .right{position:absolute;right:0;top:0;bottom:0;width:240px;z-index:5;box-shadow:-6px 0 18px rgba(0,0,0,.25)}
.app[data-layout=narrow] .side,.app[data-layout=narrow] .right{border:none}
.side-head,.right-head{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px;border-bottom:1px solid var(--oc-border)}
.side-head h1{flex:1;margin:0;font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none;background:var(--oc-muted)}
.dot.busy{background:var(--oc-success)}
.dot.idle{background:var(--oc-warning)}
.dot.dormant{background:var(--oc-muted);opacity:.6}
.dot.off{background:var(--oc-error)}
.side-list{flex:1;min-height:0;overflow-y:auto;padding:4px 0}
.sec-head{display:flex;align-items:center;gap:6px;padding:10px 12px 4px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--oc-muted)}
.sec-head span{flex:1}
.icon-btn{border:none;background:transparent;color:var(--oc-muted);cursor:pointer;border-radius:6px;padding:2px 7px;font-size:15px;line-height:1.2}
.icon-btn:hover{background:var(--oc-hover);color:var(--oc-fg)}
.row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:8px;margin:1px 6px;cursor:pointer;min-width:0;border:none;background:transparent;width:calc(100% - 12px);text-align:left}
.row:hover{background:var(--oc-hover)}
.row[aria-current=true]{background:var(--oc-selection);color:var(--oc-selection-fg)}
.row .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row.unread .name{font-weight:600}
.count{min-width:18px;padding:0 6px;border-radius:9px;font-size:11px;text-align:center;background:var(--oc-muted-surface);color:var(--oc-fg);flex:none}
.count.mention{background:var(--oc-primary);color:var(--oc-primary-fg)}
.awake{font-size:11px;color:var(--oc-success-text);flex:none;display:inline-flex;align-items:center;gap:3px}
.awake .dot{width:6px;height:6px;background:var(--oc-success)}
.empty-note{padding:6px 14px;color:var(--oc-muted);font-size:12px}
.side-foot{flex:none;border-top:1px solid var(--oc-border);padding:8px 12px;font-size:11px;color:var(--oc-muted)}
.side-foot p{margin:0 0 4px}

.chat{display:flex;flex-direction:column;min-width:0;min-height:0}
.chat-head{flex:none;display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--oc-border);min-height:44px}
.chat-title{min-width:0;flex:1;display:flex;flex-direction:column}
.chat-title b{font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chat-title small{color:var(--oc-muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.head-btn{border:1px solid var(--oc-border);background:transparent;border-radius:8px;padding:3px 9px;cursor:pointer;font-size:12px;white-space:nowrap}
.head-btn:hover{background:var(--oc-hover)}
.head-btn[hidden],.icon-btn[hidden]{display:none}
.chat-body{flex:1;min-height:0;position:relative;display:flex;flex-direction:column}
.msgs{flex:1;min-height:0;overflow-y:auto;padding:6px 0 10px;overflow-anchor:none}
.msg{padding:1px 14px}
.msg.first{margin-top:8px}
.msg.mention{background:color-mix(in srgb,var(--oc-primary) 10%,transparent);box-shadow:inset 2px 0 0 var(--oc-primary)}
.mh{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;min-width:0}
.nick{font-weight:600;overflow-wrap:anywhere}
.time{color:var(--oc-muted);font-size:11px;font-variant-numeric:tabular-nums}
.tag{font-size:10px;line-height:1.5;padding:0 6px;border-radius:8px;border:1px solid var(--oc-border);text-transform:uppercase;letter-spacing:.04em;color:var(--oc-muted)}
.tag.op{color:var(--oc-primary-text);border-color:var(--oc-primary)}
.tag.bc{color:var(--oc-warning-text);border-color:var(--oc-warning)}
.mb{white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}
.mb.notice{font-style:italic;color:var(--oc-muted)}
mark.me{background:color-mix(in srgb,var(--oc-primary) 28%,transparent);color:inherit;border-radius:3px;padding:0 2px}
mark.bc{background:color-mix(in srgb,var(--oc-warning) 25%,transparent);color:inherit;border-radius:3px;padding:0 2px}
.clamp .mb{max-height:13em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 65%,transparent);mask-image:linear-gradient(#000 65%,transparent)}
.more{border:none;background:transparent;color:var(--oc-primary-text);cursor:pointer;padding:0;font-size:12px}
.sys{padding:1px 14px;color:var(--oc-muted);font-size:11px;overflow-wrap:anywhere}
.day{display:flex;align-items:center;gap:8px;margin:10px 14px 2px;color:var(--oc-muted);font-size:11px}
.day::before,.day::after{content:"";flex:1;height:1px;background:var(--oc-border)}
.loading-note{text-align:center;color:var(--oc-muted);font-size:12px;padding:6px}
.pill{position:absolute;left:50%;bottom:10px;transform:translateX(-50%);background:var(--oc-primary);color:var(--oc-primary-fg);border:none;border-radius:999px;padding:4px 12px;font-size:12px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.pill[hidden]{display:none}
.blank[hidden]{display:none}
.blank{flex:1;display:flex;align-items:center;justify-content:center;padding:20px;text-align:center;color:var(--oc-muted)}

.composer{flex:none;border-top:1px solid var(--oc-border);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.composer-row{display:flex;gap:8px;align-items:flex-end}
.composer textarea{flex:1;min-width:0;resize:none;background:var(--oc-bg);color:var(--oc-fg);border:1px solid var(--oc-border);border-radius:var(--oc-radius,8px);padding:8px 10px;font:inherit;line-height:1.4;max-height:180px;min-height:38px}
.composer textarea:focus{outline:2px solid var(--oc-focus);outline-offset:-1px}
.composer textarea:disabled{opacity:.6}
.quick{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--oc-muted)}
.quick .to{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font-size:12px;padding:1px 9px;border:1px solid var(--oc-border);border-radius:999px;background:transparent;cursor:pointer}
.chip:hover{background:var(--oc-hover)}
.chip.warn{border-color:var(--oc-warning);color:var(--oc-warning-text)}
.err{color:var(--oc-error-text);font-size:12px;overflow-wrap:anywhere}
.err:empty{display:none}

.right-tabs{flex:none;padding:8px 10px;border-bottom:1px solid var(--oc-border);display:flex;gap:6px;align-items:center}
.right-tabs .oc-sdk{flex:1;min-width:0}
.right-body{flex:1;min-height:0;overflow-y:auto;padding:4px 0;position:relative}
.member{display:flex;align-items:center;gap:8px;padding:5px 10px;margin:1px 6px;border-radius:8px;cursor:pointer;min-width:0}
.member:hover{background:var(--oc-hover)}
.member .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.member .sub{font-size:10px;color:var(--oc-muted);flex:none}
.member.dormant .name,.member.idle .name{color:var(--oc-muted)}
.popmenu{position:absolute;z-index:20;background:var(--oc-elevated);border:1px solid var(--oc-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:4px;min-width:150px;display:flex;flex-direction:column}
.popmenu button{border:none;background:transparent;text-align:left;padding:6px 10px;border-radius:6px;cursor:pointer}
.popmenu button:hover{background:var(--oc-hover)}
.popmenu button.danger{color:var(--oc-error-text)}
.popover{position:absolute;z-index:20;left:8px;right:8px;top:44px;max-height:60%;display:flex;flex-direction:column;gap:6px;background:var(--oc-elevated);border:1px solid var(--oc-border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.35);padding:8px;overflow:hidden}
.popover .list{overflow-y:auto;min-height:0}
.result{margin:6px 8px;padding:8px 10px;border:1px solid var(--oc-border);border-radius:10px;background:var(--oc-muted-surface);font-size:12px;position:relative}
.result b{display:block;margin-bottom:2px;padding-right:20px}
.result pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--oc-mono,monospace);font-size:11px}
.result .x{position:absolute;right:4px;top:2px}
.claim{padding:6px 12px;border-bottom:1px solid var(--oc-border);font-size:12px}
.claim .path{font-family:var(--oc-mono,monospace);overflow-wrap:anywhere}
.claim .meta{color:var(--oc-muted);font-size:11px}

.setup{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--oc-bg);z-index:30;overflow:auto}
.setup[hidden]{display:none}
.setup-card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px}
.setup-card h2{margin:0;font-size:18px}
.setup-card p{margin:0;color:var(--oc-muted);font-size:13px}
.setup-card .actions{display:flex;gap:8px;align-items:center}
.setup-card .err{font-size:13px}
`;
