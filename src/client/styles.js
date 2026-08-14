/**
 * 样式（apply 时注入一次 <style>）。
 * dock 面板宽度对齐官方 todo/queue dock 卡片（ui-conversation 内建）：
 * width = 100% - 2×side-clearance - 2×dock-inset；
 * max-width = card-max-width - 2×dock-inset（钳制，容器再宽也不会全宽）。
 */
const PANEL_CSS = `
.ts-dock{box-sizing:border-box;flex:none;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto;padding:0 var(--dsh-composer-dock-inset)}
.ts-dock-panel{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);box-shadow:var(--dsw-shadow-lv1);border-radius:12px;width:100%;overflow:hidden}
.ts-dock-head{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:transparent;border:none;border-radius:8px;align-items:center;gap:10px;padding:4px 12px;display:flex;transition:background-color 120ms ease}
.ts-dock-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .12s}
.ts-dock[data-open="true"] .ts-dock-chevron{transform:rotate(180deg)}
.ts-dock-title{color:var(--dsw-alias-label-primary);flex:none;font-size:13px;font-weight:500;line-height:24px}
.ts-dock-progress{min-width:0;color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;flex:auto;font-size:13px;line-height:20px;overflow:hidden}
.ts-dock-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.ts-dock-body{flex-direction:column;max-height:220px;padding:2px 0;display:flex;overflow-y:auto}
.ts-dock-seg{padding:6px 12px 6px 24px}
.ts-dock-seg + .ts-dock-seg{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.ts-dock-seg-head{display:flex;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.ts-dock-placeholder{padding:6px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ts-dock-prev{display:flex;align-items:center;gap:6px;width:100%;padding:5px 12px;background:transparent;border:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-dock-prev:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-dock-prev-chevron{transition:transform .12s}
.ts-dock-prev[aria-expanded="true"] .ts-dock-prev-chevron{transform:rotate(90deg)}
.ts-dock-prev-body{box-shadow:inset 0 1px 0 var(--dsw-alias-border-l1)}
.ts-seg-refined{color:var(--dsw-alias-state-business-primary)}
.ts-seg-skip{color:var(--dsw-alias-label-tertiary)}
.ts-tail{margin:4px 16px 4px 30px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.ts-tail-head{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-tail-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-tail-chevron{transition:transform .12s;color:var(--dsw-alias-label-tertiary)}
.ts-tail[data-open="true"] .ts-tail-chevron{transform:rotate(180deg)}
.ts-tail-title{font-weight:600}
.ts-tail-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px}
.ts-tail-refined{color:var(--dsw-alias-state-business-primary);font-size:11px}
.ts-tail-body{border-top:1px solid var(--dsw-alias-separator-primary);max-height:320px;overflow-y:auto}
.ts-tail-seg{padding:6px 10px 6px 26px}
.ts-tail-seg + .ts-tail-seg{border-top:1px solid var(--dsw-alias-separator-primary)}
.ts-tail-seg-head{display:flex;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-tail-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
.ts-view{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width) - 2 * var(--dsh-composer-dock-inset, 8px));margin:0 auto;padding:16px 12px 32px}
.ts-view-header{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
.ts-view-title-lg{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ts-view-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ts-view-empty{padding:24px 4px;font-size:13px;color:var(--dsw-alias-label-tertiary)}
.ts-view-list{flex-direction:column;gap:8px;display:flex}
.ts-view-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:8px;overflow:hidden}
.ts-view-head{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;background:transparent;border:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left;transition:background-color 120ms ease}
.ts-view-head:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ts-view-chevron{transition:transform .12s;color:var(--dsw-alias-label-tertiary);flex:none}
.ts-view-card[data-open="true"] .ts-view-chevron{transform:rotate(180deg)}
.ts-view-title{font-weight:600;flex:none}
.ts-view-meta{flex:1;color:var(--dsw-alias-label-tertiary);font-size:11px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}
.ts-view-body{border-top:1px solid var(--dsw-alias-separator-primary);max-height:360px;overflow-y:auto}
.ts-view-seg{padding:6px 12px 6px 26px}
.ts-view-seg + .ts-view-seg{border-top:1px solid var(--dsw-alias-separator-primary)}
.ts-view-seg-head{display:flex;gap:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.ts-view-seg-text{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;white-space:pre-wrap}
`
