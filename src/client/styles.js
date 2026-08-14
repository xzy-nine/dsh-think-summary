/**
 * 样式（apply 时注入一次 <style>）。
 * dock 面板配合输入框样式：input-major 背景 + 圆角 + 宽度对齐 composer 卡片。
 */
const PANEL_CSS = `
.ts-dock{flex:none;width:100%;max-width:var(--dsh-composer-card-max-width);margin:0 auto}
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
`
