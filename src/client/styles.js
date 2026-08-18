/**
 * 样式（apply 时注入一次 <style>）。
 * 全部对齐 **原生 dsh 风格**（dsh-client-ui-settings-plugins PluginCard / ValueField、
 * conversation QueueDock / trajectory 等原生模块的设计语言）：
 *  - 卡片：radius 12px、border-l2、bg-layer-3（展开 bg-layer-2）、hover 边框 label-dimmed
 *  - 字段：纵向布局（label 在上、控件在下、hint 在下），field+field 顶部 border-l2
 *  - 输入：34px 高、radius 8、bg-layer-3、focus 边框 brand-primary
 *  - 按钮：保存=反色主按钮（label-primary 底 + bg-layer-3 字），恢复=描边次按钮
 *  - 开关：原生 trajectory 小开关（track 20×10、thumb 6×6、开=state-business-primary）
 *  - 状态标签：原生 pill badge（bg-module-platform、radius 999、11px/500）
 * dock 面板宽度沿用官方 todo/queue dock 公式。
 */
const PANEL_CSS = `
/* ---------- 输入框上方实时面板（对齐原生 QueueDock） ---------- */
.ts-dock{box-sizing:border-box;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset)}
.ts-dock-panel{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);box-shadow:var(--dsw-shadow-lv1);border-radius:12px;width:100%;overflow:hidden}
.ts-dock-head{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);text-align:left;align-items:center;gap:10px;padding:4px 8px 4px 4px;display:flex}
.ts-dock-toggle{display:flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;background:transparent;border:none;border-radius:4px;cursor:pointer;color:inherit;transition:background-color 120ms ease}
.ts-dock-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .12s}
/* 展开时箭头朝下（指向内容），收起时朝上 */
.ts-dock[data-open="false"] .ts-dock-chevron{transform:rotate(180deg)}
.ts-dock-paused{flex:none;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-warn-primary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
/* 暂停/继续：对齐侧边栏"工作区"行功能按钮（iconButton） */
.ts-dock-pause{cursor:pointer;width:16px;height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:4px;flex:none;justify-content:center;align-items:center;padding:0;display:inline-flex;transition:color 120ms ease,background-color 120ms ease}
.ts-dock-pause:hover{color:var(--dsw-alias-label-primary)}
.ts-dock-pause.on{color:var(--dsw-alias-state-warn-primary)}
.ts-dock-pause:disabled{opacity:.5;cursor:default}
.ts-dock-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}
.ts-dock-progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:20px;overflow:hidden}
.ts-dock-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.ts-dock-body{flex-direction:column;max-height:220px;padding:2px 0;display:flex;overflow-y:auto}
.ts-dock-seg{padding:6px 12px 6px 24px}
.ts-dock-seg + .ts-dock-seg{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.ts-dock-seg-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.ts-dock-placeholder{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-prev{display:flex;align-items:center;gap:6px;width:100%;padding:5px 12px;background:transparent;border:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-dock-prev:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-prev-chevron{transition:transform .12s}
.ts-dock-prev[aria-expanded="true"] .ts-dock-prev-chevron{transform:rotate(90deg)}
.ts-dock-prev-body{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}

/* ---------- 状态标签：原生 pill badge ---------- */
.ts-seg-refined,.ts-seg-skip,.ts-seg-pending,.ts-seg-self{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ts-seg-refined{color:var(--dsw-alias-state-business-primary)}
.ts-seg-skip{color:var(--dsw-alias-label-tertiary)}
.ts-seg-pending{color:var(--dsw-alias-label-tertiary)}
.ts-seg-self{color:var(--dsw-alias-state-warn-primary)}

/* ---------- 对话末尾思考总结条（对齐原生卡片） ---------- */
.ts-tail{margin:4px 16px 4px 30px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;overflow:hidden;transition:border-color .16s,background .16s}
.ts-tail:hover{border-color:var(--dsw-alias-label-dimmed)}
.ts-tail[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ts-tail-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 12px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-tail-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-tail-chevron{transition:transform .16s;color:var(--dsw-alias-label-tertiary);flex:none}
.ts-tail[data-open="true"] .ts-tail-chevron{transform:rotate(180deg)}
.ts-tail-title{font-weight:600}
.ts-tail-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400}
.ts-tail-refined{color:var(--dsw-alias-state-business-primary);font-size:11px;font-weight:500}
.ts-tail-body{border-top:1px solid var(--dsw-alias-border-l2);max-height:320px;overflow-y:auto}
.ts-tail-seg{padding:6px 12px 6px 26px}
.ts-tail-seg + .ts-tail-seg{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-tail-group + .ts-tail-group{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-tail-group-head{padding:5px 12px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);letter-spacing:.02em}
.ts-tail-seg-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-tail-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}

/* ---------- 思考总结视图（对齐原生 trajectory 工具栏 + 原生卡片） ---------- */
.ts-view{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 2 * var(--dsh-composer-dock-inset, 8px));margin:0 auto;padding:0 12px 32px}
.ts-view-header{position:sticky;top:0;z-index:1;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);align-items:baseline;gap:10px;padding:8px 4px;display:flex}
.ts-view-title-lg{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}
.ts-view-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ts-view-empty{padding:24px 4px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.ts-view-list{flex-direction:column;gap:10px;padding-top:10px;display:flex}
.ts-view-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;overflow:hidden;transition:border-color .16s,background .16s}
.ts-view-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.ts-view-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ts-view-head{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:500;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-view-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-view-chevron{transition:transform .16s;color:var(--dsw-alias-label-tertiary);flex:none}
.ts-view-card[data-open="true"] .ts-view-chevron{transform:rotate(180deg)}
.ts-view-title{font-weight:600}
.ts-view-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ts-view-body{border-top:1px solid var(--dsw-alias-border-l2);max-height:360px;overflow-y:auto}
.ts-view-seg{padding:6px 12px 6px 26px}
.ts-view-seg + .ts-view-seg{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-view-seg-head{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-view-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}

/* ---------- 设置卡片（对齐原生 PluginCard + ValueField） ---------- */
.ts-set-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;overflow:hidden;transition:border-color .16s,background .16s}
.ts-set-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.ts-set-card[data-open="true"]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.ts-set-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.ts-set-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ts-set-headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.ts-set-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.ts-set-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.ts-set-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.ts-set-card[data-open="true"] .ts-set-chevron{transform:rotate(180deg)}
.ts-set-body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}
.ts-set-group{padding-top:4px}
.ts-set-group-head{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:6px;align-items:center;gap:8px;margin:12px 0 0;padding:4px 2px;display:flex}
.ts-set-group-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-set-group-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.ts-set-caption{color:var(--dsw-alias-label-secondary);flex:1;font-size:12px;font-weight:500;line-height:18px}
.ts-set-group-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.ts-set-group[data-open="true"] .ts-set-group-chevron{transform:rotate(180deg)}
.ts-set-field{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.ts-set-field + .ts-set-field{border-top:1px solid var(--dsw-alias-border-l2)}
.ts-set-head{align-items:center;gap:8px;display:flex}
.ts-set-label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.ts-set-unit{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.ts-set-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;box-sizing:border-box}
.ts-set-input:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.ts-set-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.ts-set-textarea{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:8px 12px;font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box}
.ts-set-textarea:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.ts-set-textarea:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.ts-set-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.ts-set-footer{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.ts-set-msg{min-width:0;color:var(--dsw-alias-label-tertiary);flex:1;margin:0;font-size:12px;line-height:1.5}
.ts-set-msg[data-kind="ok"]{color:var(--dsw-alias-state-success-primary)}
.ts-set-msg[data-kind="err"]{color:var(--dsw-alias-state-error-primary)}
.ts-set-discard,.ts-set-save{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.ts-set-discard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:transparent}
.ts-set-discard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.ts-set-save{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.ts-set-discard:disabled,.ts-set-save:disabled{opacity:.4;cursor:default}
.ts-set-discard:focus-visible,.ts-set-save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.ts-set-toggle{position:relative;width:30px;height:17px;border-radius:9px;border:none;cursor:pointer;background:var(--dsw-alias-interactive-bg-hover);flex:none;padding:0;transition:background .12s}
.ts-set-toggle[data-on="true"]{background:var(--dsw-alias-state-business-primary)}
.ts-set-toggle-thumb{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.3);transition:left .12s}
.ts-set-toggle[data-on="true"] .ts-set-toggle-thumb{left:15px}
.ts-set-toggle:disabled{opacity:.5;cursor:default}
`
