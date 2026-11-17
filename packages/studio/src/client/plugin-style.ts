export const PLUGIN_STYLE = `
.dsh-st-card{list-style:none;border:0;background:none;padding:0}
.dsh-st-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 0 6px}
.dsh-st-head-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}
.dsh-st-title{display:block;font-size:15px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-desc{display:block;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.dsh-st-body{padding:0}
.dsh-st-field{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsh-st-field + .dsh-st-field{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsh-st-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;font-size:13px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px);background:var(--dsw-alias-bg-layer-3,transparent);color:inherit;outline:none;transition:border-color .15s}
.dsh-st-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsh-st-textarea{resize:vertical;min-height:56px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.5}
.dsh-st-input-group{display:flex;gap:8px;align-items:center}
.dsh-st-file-row{display:flex;align-items:center;gap:10px;min-width:0}
.dsh-st-file-input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;clip-path:inset(50%)}
.dsh-st-file-button{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary,inherit);font-size:13px;cursor:pointer;transition:background .15s,border-color .15s}
.dsh-st-file-button:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-st-file-button:focus-within{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.dsh-st-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,inherit);font-size:12px}
.dsh-st-workflow-list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.dsh-st-workflow-row{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}
.dsh-st-workflow-main{display:flex;align-items:center;gap:8px}
.dsh-st-workflow-active{display:inline-flex;align-items:center;cursor:pointer;flex:none}
.dsh-st-workflow-active input[type=radio]{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer}
.dsh-st-workflow-name{flex:1;min-width:0}
.dsh-st-btn-reset{appearance:none;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px);padding:5px 12px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s}
.dsh-st-btn-reset:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-st-hint,.dsh-st-status{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4}
.dsh-st-link{color:var(--dsw-alias-brand-primary);text-decoration:none;white-space:nowrap}.dsh-st-link:hover{text-decoration:underline}
.dsh-st-hint-error{color:var(--dsw-alias-state-error-primary)}
.dsh-st-status-error{color:var(--dsw-alias-state-error-primary);font-weight:500}
.dsh-st-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-st-check-row{display:flex;align-items:center;gap:8px;cursor:pointer}
.dsh-st-check-row input[type=checkbox]{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary);margin:0}
.dsh-st-model-picker{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 12px;max-height:180px;overflow-y:auto;padding:2px 0}
.dsh-st-model-picker .dsh-st-check-row{min-width:0}
.dsh-st-model-option{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.dsh-st-model-default{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsh-st-savedto{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);word-break:break-all}
.dsh-st-save{appearance:none;border:0;border-radius:var(--dsw-radius-md,6px);padding:5px 14px;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;font-weight:400;cursor:pointer;transition:opacity .15s}
.dsh-st-save:disabled{opacity:.4;cursor:default}

/* Provider list: one expandable row per provider, each saving independently. */
.dsh-st-providers{display:flex;flex-direction:column;margin-top:12px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-3,transparent)}
.dsh-st-provider-row{border:0;background:none;padding:0 14px}
.dsh-st-provider-row + .dsh-st-provider-row{border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-st-provider-head-row{display:flex;align-items:center;gap:8px;min-height:48px}
.dsh-st-provider-head{flex:1;min-width:0;width:100%;min-height:48px;appearance:none;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;display:flex;align-items:center;gap:10px;padding:0}
.dsh-st-channel-add.dsh-st-btn-secondary{display:inline-flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);line-height:1;transition:background .15s,color .15s}
.dsh-st-channel-add.dsh-st-btn-secondary:hover:not(:disabled){border:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-channel-add svg{width:14px;height:14px}
.dsh-st-provider-head:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:var(--dsw-radius-sm,4px)}
.dsh-st-provider-head:hover .dsh-st-provider-name{color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-provider-head:hover .dsh-st-provider-chevron{color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-provider-name{flex:1;min-width:0;font-size:13px;font-weight:550;line-height:20px;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-st-provider-chevron{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;color:var(--dsw-alias-label-tertiary);transition:transform .16s,color .15s}
.dsh-st-provider-chevron-open{transform:rotate(180deg)}
.dsh-st-provider-body{border-top:0;padding:0 0 14px}
.dsh-st-badge{flex:none;display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;min-height:22px;padding:1px 8px;border:1px solid transparent;border-radius:6px;font-size:11px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary,inherit);white-space:nowrap;max-width:60%;overflow:hidden;text-overflow:ellipsis}
.dsh-st-badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex:none}
.dsh-st-badge-ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 20%,transparent);color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.dsh-st-badge-missing{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent);color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}
.dsh-st-badge-neutral{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2,transparent)}
.dsh-st-badge-checking .dsh-st-badge-dot{animation:dsh-st-pulse 1s ease-in-out infinite}
@keyframes dsh-st-pulse{50%{opacity:.25}}

/* Default provider radio pills. */
.dsh-st-radios{display:flex;flex-wrap:wrap;gap:8px}
.dsh-st-radio{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 12px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary,inherit);transition:border-color .15s,background .15s}
.dsh-st-radio:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-st-radio-checked{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent);color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-radio input[type=radio]{width:14px;height:14px;accent-color:var(--dsw-alias-brand-primary);margin:0;cursor:pointer}

/* Row-level actions: test connection, clear key, save. */
.dsh-st-row-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;flex-wrap:wrap}
.dsh-st-row-buttons{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-st-btn-secondary{appearance:none;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,6px);padding:5px 14px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary,inherit);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s}
.dsh-st-btn-secondary:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-st-btn-secondary:disabled{opacity:.45;cursor:default}
.dsh-st-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)}
.dsh-st-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent)}

/* Workspace section within the settings card. */
.dsh-st-section{display:flex;flex-direction:column;gap:6px;margin-top:20px;padding-top:14px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.dsh-st-section-title{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-status-readonly{color:var(--dsw-alias-label-tertiary);font-style:italic}

.dsh-st-result{display:grid;gap:10px;max-width:520px}
.dsh-st-promoted-results{display:grid;gap:16px}
.dsh-st-result-title{font-size:14px;font-weight:600}
.dsh-st-container{position:relative;display:inline-block;width:fit-content;max-width:100%;justify-self:start;border-radius:12px;overflow:hidden;line-height:0;isolation:isolate}
.dsh-st-container:hover .dsh-st-toolbar,.dsh-st-container:focus-within .dsh-st-toolbar{opacity:1;pointer-events:auto}
.dsh-st-toolbar{position:absolute;top:8px;left:8px;display:flex;align-items:center;gap:5px;padding:3px 5px;border-radius:8px;background:color-mix(in srgb,black 65%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:2;line-height:1}
.dsh-st-tool-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-on-color);padding:5px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.dsh-st-tool-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-on-color) 25%,transparent)}
.dsh-st-tool-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 75%,transparent)!important;color:var(--dsw-alias-label-on-color)!important}
.dsh-st-toast{position:absolute;top:100%;left:0;margin-top:5px;padding:3px 8px;border-radius:6px;background:color-mix(in srgb,black 85%,transparent);color:var(--dsw-alias-label-on-color);font-size:11px;white-space:nowrap;pointer-events:none;z-index:4}
.dsh-st-image{display:block;max-width:100%;max-height:520px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);cursor:pointer}
.dsh-st-version-nav{position:absolute;right:8px;bottom:8px;display:flex;align-items:center;gap:2px;padding:3px;border-radius:999px;background:color-mix(in srgb,currentColor 72%,transparent);color:var(--dsw-alias-label-on-color);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);font-size:11px;line-height:1;z-index:2}
.dsh-st-version-nav button{appearance:none;border:0;background:transparent;color:inherit;width:25px;height:25px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:17px;line-height:1}
.dsh-st-version-nav button:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-on-color) 20%,transparent)}
.dsh-st-version-nav button:disabled{opacity:.3;cursor:default}
.dsh-st-version-count{min-width:34px;text-align:center;font-variant-numeric:tabular-nums}
.dsh-st-regenerate-overlay{position:absolute;inset:0;background:color-mix(in srgb,currentColor 52%,transparent);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-on-color);z-index:3;animation:dsh-st-fade .18s ease-out;line-height:1.4;border-radius:12px}
.dsh-st-regenerate-spinner{width:28px;height:28px;border:3px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 25%,transparent);border-top-color:var(--dsw-alias-label-on-color);border-radius:50%;animation:dsh-st-spin .8s linear infinite}
.dsh-st-regenerate-overlay-text{font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-on-color);letter-spacing:0.2px;text-shadow:0 1px 2px color-mix(in srgb,black 40%,transparent)}
.dsh-st-regenerate-overlay-cancel{appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 40%,transparent);border-radius:6px;background:color-mix(in srgb,var(--dsw-alias-label-on-color) 15%,transparent);color:var(--dsw-alias-label-on-color);padding:3px 12px;font-size:11.5px;cursor:pointer;transition:background .15s}
.dsh-st-regenerate-overlay-cancel:hover{background:color-mix(in srgb,var(--dsw-alias-label-on-color) 30%,transparent)}
@keyframes dsh-st-spin{to{transform:rotate(360deg)}}
.dsh-st-regenerate-backdrop{position:fixed;inset:0;z-index:100000;display:flex;align-items:center;justify-content:center;padding:18px;background:color-mix(in srgb,currentColor 60%,transparent);backdrop-filter:blur(5px);-webkit-backdrop-filter:blur(5px);animation:dsh-st-fade .15s ease-out}
.dsh-st-regenerate-dialog{width:min(520px,100%);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 24px 72px color-mix(in srgb,currentColor 28%,transparent);padding:20px;box-sizing:border-box;line-height:1.4}
.dsh-st-regenerate-dialog h3{margin:0;font-size:16px;font-weight:650}
.dsh-st-regenerate-dialog p{margin:7px 0 16px;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.55}
.dsh-st-regenerate-dialog label{display:grid;gap:7px;font-size:12.5px;font-weight:600}
.dsh-st-regenerate-dialog textarea{box-sizing:border-box;width:100%;min-height:132px;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:11px 12px;background:var(--dsw-alias-bg-layer-2);color:inherit;font:inherit;font-size:13px;line-height:1.55;outline:none}
.dsh-st-regenerate-dialog textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dsh-st-regenerate-error{margin-top:10px!important;color:var(--dsw-alias-state-error-primary)!important}
.dsh-st-regenerate-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:16px}
.dsh-st-regenerate-actions button{height:35px;padding:0 14px;border-radius:7px;font:inherit;font-size:13px;font-weight:550;cursor:pointer}
.dsh-st-regenerate-cancel{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit}
.dsh-st-regenerate-confirm{border:1px solid var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}
.dsh-st-regenerate-actions button:disabled{opacity:.5;cursor:default}
@media(hover:none){.dsh-st-container .dsh-st-toolbar{opacity:1;pointer-events:auto}}
@keyframes dsh-st-fade{from{opacity:0}to{opacity:1}}
.dsh-st-error{color:var(--dsw-alias-state-error-primary);font-size:13px}
.dsh-st-loading{color:var(--dsw-alias-label-tertiary);font-size:13px}

/* Native Workspace Gallery & Studio View (Renders seamlessly inside DSH Session View) */
.dsh-st-gallery-page{width:100%;height:100%;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;overflow:hidden;flex:1}

/* 1. Top Navigation Tab Bar */
.dsh-st-studio-tabs-bar{display:flex;align-items:center;gap:6px;padding:6px 24px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);flex-shrink:0}
.dsh-st-studio-tab-btn{appearance:none;-webkit-appearance:none;border:0;background:transparent;display:inline-flex;align-items:center;gap:7px;padding:7px 14px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:6px;transition:color .15s ease,background-color .15s ease}
.dsh-st-studio-tab-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}
.dsh-st-studio-tab-btn.is-active{color:var(--dsw-alias-brand-primary);font-weight:600;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,transparent)}

/* 2. Secondary Filter & Search Toolbar */
.dsh-st-studio-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 24px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);flex-shrink:0;flex-wrap:nowrap;min-width:0}
.dsh-st-studio-toolbar-left{display:flex;align-items:center;gap:10px;flex-wrap:nowrap;flex:1;min-width:0}
.dsh-st-studio-toolbar-right{display:flex;align-items:center;gap:10px;flex-shrink:0}

/* Modern Custom Select (Removes OS default arrows & ugly borders) */
.dsh-st-studio-select{appearance:none;-webkit-appearance:none;-moz-appearance:none;height:32px;line-height:30px;padding:0 28px 0 12px;font-size:12.5px;color:var(--dsw-alias-label-primary);background-color:var(--dsw-alias-bg-layer-2);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 9px center;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none;cursor:pointer;box-sizing:border-box;transition:border-color .15s ease,box-shadow .15s ease,background-color .15s ease}
.dsh-st-studio-select:hover{border-color:var(--dsw-alias-border-l1);background-color:var(--dsw-alias-bg-layer-1)}
.dsh-st-studio-select:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.dsh-st-studio-select-sort{font-weight:500}

/* Unified Search Input */
.dsh-st-studio-search-wrap{position:relative;display:flex;align-items:center;min-width:140px;max-width:320px;flex:1}
.dsh-st-studio-search-icon{position:absolute;left:10px;color:var(--dsw-alias-label-tertiary);pointer-events:none}
.dsh-st-studio-search-input{width:100%;height:32px;line-height:30px;padding:0 12px 0 32px;font-size:12.5px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background-color:var(--dsw-alias-bg-layer-2);color:inherit;outline:none;box-sizing:border-box;transition:border-color .15s ease,box-shadow .15s ease}
.dsh-st-studio-search-input:hover{border-color:var(--dsw-alias-border-l1)}
.dsh-st-studio-search-input:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent)}
.dsh-st-studio-search-input::placeholder{color:var(--dsw-alias-label-tertiary)}

/* 3. Grid & Responsive Cards */
.dsh-st-gallery-page-body{flex:1;overflow-y:auto;padding:20px 24px}
.dsh-st-gallery-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:18px}
.dsh-st-gallery-sentinel{grid-column:1/-1;height:1px;width:100%}
.dsh-st-gallery-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;display:flex;flex-direction:column;cursor:pointer;transition:transform .18s ease,box-shadow .18s ease,border-color .18s ease;content-visibility:auto;contain-intrinsic-size:auto 280px}
.dsh-st-gallery-card:hover{transform:translateY(-2px);box-shadow:0 10px 20px -5px color-mix(in srgb,black 6%,transparent),0 4px 6px -2px color-mix(in srgb,black 3%,transparent);border-color:var(--dsw-alias-border-l1)}
.dsh-st-gallery-card-media{position:relative;width:100%;aspect-ratio:1/1;background:var(--dsw-alias-bg-layer-2);overflow:hidden;display:flex;align-items:center;justify-content:center}
.dsh-st-gallery-card-img{width:100%;height:100%;object-fit:cover;transition:transform .2s ease}
.dsh-st-gallery-card:hover .dsh-st-gallery-card-img{transform:scale(1.03)}
.dsh-st-gallery-card-loading{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dsh-st-gallery-card-error{font-size:12px;color:var(--dsw-alias-state-error-primary);padding:8px;text-align:center}

/* Floating Action Toolbar on Card Hover */
.dsh-st-gallery-card:hover .dsh-st-card-toolbar{opacity:1;pointer-events:auto}
.dsh-st-card-toolbar{position:absolute;top:6px;left:6px;display:flex;align-items:center;gap:3px;padding:3px 5px;border-radius:6px;background:color-mix(in srgb,currentColor 72%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);opacity:0;pointer-events:none;transition:opacity .18s ease;z-index:10;line-height:1}

/* Card Bottom Metadata */
.dsh-st-gallery-card-meta{padding:10px 12px;display:flex;flex-direction:column;gap:5px;background:var(--dsw-alias-bg-layer-2);flex:1}
.dsh-st-card-badge-row{display:flex;align-items:center}
.dsh-st-card-badge{display:inline-block;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-st-gallery-card-prompt-line{font-size:12.5px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:1.4;min-height:1.4em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* An imported image has no prompt: its line keeps one row of height and the footer sits at the bottom, so mixed rows align (black). */
.dsh-st-card-footer-row{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:auto;padding-top:2px}
.dsh-st-card-meta-text{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-st-card-fav-btn{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);padding:2px;border-radius:4px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:color .15s,transform .15s;flex-shrink:0}
.dsh-st-card-fav-btn:hover{color:var(--dsw-alias-state-error-primary);transform:scale(1.15)}
.dsh-st-card-fav-btn.is-favorited{color:var(--dsw-alias-state-error-primary)}

/* Placeholders for Upcoming Routes */
.dsh-st-placeholder-view{display:flex;align-items:center;justify-content:center;min-height:360px;height:100%;padding:24px}
.dsh-st-placeholder-card{max-width:500px;width:100%;text-align:center;padding:36px 28px;background:var(--dsw-alias-bg-layer-2);border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;display:flex;flex-direction:column;align-items:center;gap:12px}
.dsh-st-placeholder-icon{font-size:40px;line-height:1}
.dsh-st-placeholder-header{display:flex;align-items:center;gap:8px;justify-content:center}
.dsh-st-placeholder-title{font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);margin:0}
.dsh-st-placeholder-badge{font-size:11px;font-weight:500;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary);padding:2px 8px;border-radius:12px}
.dsh-st-placeholder-desc{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);margin:0}
.dsh-st-placeholder-tip{margin-top:6px;padding:8px 12px;font-size:12px;background:var(--dsw-alias-bg-layer-3);border-radius:8px;color:var(--dsw-alias-label-tertiary);text-align:left}

/* Empty State */
.dsh-st-gallery-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:360px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dsh-st-gallery-empty-icon{display:block;width:44px;height:44px;margin-bottom:10px;color:var(--dsw-alias-label-tertiary);opacity:.7}
.dsh-st-gallery-empty-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,inherit);margin-bottom:4px}
.dsh-st-gallery-empty-desc{font-size:13px;max-width:360px;line-height:1.5}

/* Pure Centered Lightbox */
.dsh-st-lightbox-backdrop{position:fixed;inset:0;z-index:99999;background:color-mix(in srgb,black 88%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;box-sizing:border-box;cursor:zoom-out;animation:dsh-st-fade .15s ease-out}
.dsh-st-lightbox-topbar{position:absolute;top:20px;left:24px;right:24px;display:flex;align-items:center;justify-content:space-between;z-index:10;pointer-events:none}
.dsh-st-lightbox-meta{display:flex;align-items:center;gap:8px;pointer-events:auto}
.dsh-st-tag{display:inline-block;padding:2px 6px;border-radius:4px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary,inherit);font-weight:500;text-transform:uppercase;font-size:10px}
.dsh-st-tag-model{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:var(--dsw-alias-brand-primary)}
.dsh-st-lightbox-close-btn{appearance:none;border:0;background:color-mix(in srgb,var(--dsw-alias-label-on-color) 15%,transparent);color:var(--dsw-alias-label-on-color);border-radius:50%;width:34px;height:34px;font-size:16px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:background .15s;pointer-events:auto}
.dsh-st-lightbox-close-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-on-color) 30%,transparent)}
.dsh-st-lightbox-img-wrap{max-width:86vw;max-height:78vh;display:flex;align-items:center;justify-content:center;cursor:default}
.dsh-st-lightbox-img{max-width:100%;max-height:78vh;object-fit:contain;border-radius:8px;box-shadow:0 24px 60px color-mix(in srgb,black 70%,transparent);user-select:none}
.dsh-st-lightbox-bottombar{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);max-width:min(90vw,640px);background:color-mix(in srgb,currentColor 85%,transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 15%,transparent);border-radius:14px;padding:10px 16px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-on-color);box-shadow:0 16px 40px color-mix(in srgb,black 50%,transparent);cursor:default}
.dsh-st-lightbox-prompt-text{font-size:13px;line-height:1.4;color:color-mix(in srgb,var(--dsw-alias-label-on-color) 92%,transparent);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.dsh-st-lightbox-counter{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-label-on-color) 15%,transparent);color:var(--dsw-alias-label-on-color);font-size:11.5px;font-weight:500;font-variant-numeric:tabular-nums}
.dsh-st-lightbox-nav-btn{position:fixed;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 18%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-on-color) 12%,transparent);color:var(--dsw-alias-label-on-color);display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:100;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);transition:background-color .15s ease,transform .15s ease,opacity .15s ease;outline:none}
.dsh-st-lightbox-nav-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-on-color) 28%,transparent);transform:translateY(-50%) scale(1.08)}
.dsh-st-lightbox-nav-btn:disabled{opacity:0.2;cursor:not-allowed;pointer-events:none}
.dsh-st-lightbox-nav-prev{left:24px}
.dsh-st-lightbox-nav-next{right:24px}
.dsh-st-lightbox-loading{display:flex;align-items:center;justify-content:center;min-width:180px;min-height:180px}
.dsh-st-lightbox-spinner{width:36px;height:36px;border:3px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 20%,transparent);border-top-color:var(--dsw-alias-label-on-color);border-radius:50%;animation:dsh-st-spin .8s linear infinite}
@keyframes dsh-st-spin{to{transform:rotate(360deg)}}
.dsh-st-lightbox-btn{appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 18%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-on-color) 8%,transparent);color:var(--dsw-alias-label-on-color);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:background .15s,border-color .15s,color .15s}
.dsh-st-lightbox-btn:hover{background:color-mix(in srgb,var(--dsw-alias-label-on-color) 22%,transparent)}
.dsh-st-lightbox-btn-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-st-lightbox-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)!important;color:var(--dsw-alias-label-on-color)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 70%,transparent)!important}
.dsh-st-gallery-page-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:color-mix(in srgb,black 85%,transparent);color:var(--dsw-alias-label-on-color);padding:6px 14px;border-radius:8px;font-size:13px;z-index:99999;animation:dsh-st-fade .15s}

/* Card selection and checkbox */
.dsh-st-gallery-card.is-selected{box-shadow:0 0 0 2px var(--dsw-alias-brand-primary);border-color:transparent}
.dsh-st-card-checkbox{position:absolute;top:8px;left:8px;width:22px;height:22px;border-radius:50%;border:1.5px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 70%,transparent);background:color-mix(in srgb,black 35%,transparent);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);color:var(--dsw-alias-label-on-color);display:inline-flex;align-items:center;justify-content:center;cursor:pointer;z-index:5;opacity:0;transition:opacity .15s ease,background-color .15s ease,border-color .15s ease;padding:0;outline:none}
.dsh-st-gallery-card:hover .dsh-st-card-checkbox,.dsh-st-gallery-card.is-manage-mode .dsh-st-card-checkbox,.dsh-st-card-checkbox.is-checked{opacity:1}
.dsh-st-card-checkbox.is-checked{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}

/* Studio button in toolbar */
.dsh-st-studio-btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;box-sizing:border-box;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary,inherit);font-size:12.5px;font-weight:500;cursor:pointer;transition:border-color .15s,background .15s,color .15s}
.dsh-st-studio-btn:hover{background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l3)}
.dsh-st-studio-btn.is-active{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color)}
.dsh-st-studio-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 6%,transparent)}
.dsh-st-studio-btn-danger:hover{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-st-studio-btn-danger.is-active{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color)}

/* Floating Batch Action Bar */
.dsh-st-batch-bar{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:16px;background:color-mix(in srgb,currentColor 92%,transparent);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 18%,transparent);border-radius:40px;padding:8px 16px;box-shadow:0 16px 40px color-mix(in srgb,black 50%,transparent);z-index:99990;animation:dsh-st-slide-up .2s cubic-bezier(0.16,1,0.3,1);color:var(--dsw-alias-label-on-color)}
@keyframes dsh-st-slide-up{from{transform:translate(-50%,20px);opacity:0}to{transform:translate(-50%,0);opacity:1}}
.dsh-st-batch-bar-left{display:flex;align-items:center;gap:10px}
.dsh-st-batch-bar-right{display:flex;align-items:center;gap:8px;border-left:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 15%,transparent);padding-left:12px}
.dsh-st-batch-counter{font-size:13px;font-weight:600;color:color-mix(in srgb,var(--dsw-alias-label-on-color) 95%,transparent);margin-right:4px}
.dsh-st-batch-btn{appearance:none;border:1px solid color-mix(in srgb,var(--dsw-alias-label-on-color) 15%,transparent);background:color-mix(in srgb,var(--dsw-alias-label-on-color) 8%,transparent);color:var(--dsw-alias-label-on-color);border-radius:20px;padding:5px 12px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px;transition:background .15s,border-color .15s,color .15s}
.dsh-st-batch-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-on-color) 20%,transparent)}
.dsh-st-batch-btn:disabled{opacity:0.4;cursor:not-allowed}
.dsh-st-batch-btn.is-favorited{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 15%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-st-batch-btn.is-favorited:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 25%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 60%,transparent)!important;color:var(--dsw-alias-label-on-color)!important}
.dsh-st-batch-btn-download:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,transparent)!important;color:var(--dsw-alias-brand-primary)!important}
.dsh-st-batch-divider{width:1px;height:16px;background:color-mix(in srgb,var(--dsw-alias-label-on-color) 18%,transparent);margin:0 2px;display:inline-block}
.dsh-st-batch-btn-danger{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 20%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 50%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsh-st-batch-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent)!important;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 80%,transparent)!important;color:var(--dsw-alias-label-on-color)!important}
.dsh-st-batch-btn-exit{border-color:transparent;background:transparent;color:color-mix(in srgb,var(--dsw-alias-label-on-color) 70%,transparent)}
.dsh-st-batch-btn-exit:hover{background:color-mix(in srgb,var(--dsw-alias-label-on-color) 10%,transparent);color:var(--dsw-alias-label-on-color)}

/* Batch Delete Confirmation Modal */
.dsh-st-modal-backdrop{position:fixed;inset:0;background:color-mix(in srgb,black 65%,transparent);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);z-index:100005;display:flex;align-items:center;justify-content:center;padding:16px;animation:dsh-st-fade .15s ease-out}
.dsh-st-modal-box{width:100%;max-width:440px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:22px;box-sizing:border-box;box-shadow:0 20px 50px color-mix(in srgb,black 45%,transparent);color:var(--dsw-alias-label-primary);animation:dsh-st-scale-up .15s ease-out}
@keyframes dsh-st-scale-up{from{transform:scale(0.95);opacity:0}to{transform:scale(1);opacity:1}}
.dsh-st-modal-header{display:flex;align-items:flex-start;gap:12px;margin-bottom:12px}
.dsh-st-modal-icon-danger{width:36px;height:36px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.dsh-st-modal-title{font-size:16px;font-weight:600;line-height:1.4}
.dsh-st-modal-body{margin-bottom:20px;padding-left:48px}
.dsh-st-modal-desc{font-size:13.5px;color:var(--dsw-alias-label-secondary);margin:0 0 14px 0;line-height:1.5}
.dsh-st-modal-checkbox-label{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary,inherit);cursor:pointer;user-select:none}
.dsh-st-modal-checkbox-label input{margin:0;cursor:pointer;width:15px;height:15px}
.dsh-st-modal-footer{display:flex;align-items:center;justify-content:flex-end;gap:10px}
.dsh-st-modal-btn{height:34px;padding:0 14px;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;transition:background .15s,border-color .15s,color .15s;outline:none}
.dsh-st-modal-btn-cancel{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary,inherit)}
.dsh-st-modal-btn-cancel:hover{background:var(--dsw-alias-bg-layer-3)}
.dsh-st-modal-btn-danger{background:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-on-color)}
.dsh-st-modal-btn-danger:hover{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-st-modal-btn-primary{background:linear-gradient(135deg,var(--dsw-alias-brand-primary),var(--dsw-alias-brand-primary));border:1px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color);display:inline-flex;align-items:center;gap:6px}
.dsh-st-modal-btn-primary:hover:not(:disabled){background:linear-gradient(135deg,var(--dsw-alias-brand-primary),var(--dsw-alias-brand-primary))}
.dsh-st-modal-btn-primary:disabled{opacity:0.5;cursor:not-allowed}
.dsh-st-regenerate-modal-box{max-width:520px}
.dsh-st-regenerate-modal-icon{width:36px;height:36px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 15%,transparent);color:var(--dsw-alias-brand-primary);display:flex;align-items:center;justify-content:center;flex-shrink:0}
.dsh-st-regenerate-modal-title-wrap{display:flex;flex-direction:column;gap:4px}
.dsh-st-regenerate-modal-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-st-regenerate-modal-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);resize:vertical;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
.dsh-st-regenerate-modal-textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}
.dsh-st-lightbox-btn-regenerate:hover{color:var(--dsw-alias-brand-primary)!important;border-color:color-mix(in srgb,currentColor 50%,transparent)!important;background:color-mix(in srgb,currentColor 12%,transparent)!important}
.dsh-st-lightbox-generating-indicator{display:inline-flex;align-items:center;gap:8px;padding:4px 12px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 50%,transparent);border-radius:20px;font-size:12px;color:var(--dsw-alias-brand-primary);animation:dsh-st-fade .15s ease-out}
.dsh-st-lightbox-spinner-sm{width:12px;height:12px;border:2px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:var(--dsw-alias-brand-primary);border-radius:50%;animation:dsh-st-spin .8s linear infinite;flex-shrink:0}
.dsh-st-lightbox-abort-btn{appearance:none;background:transparent;border:0;color:var(--dsw-alias-state-error-primary);font-size:11.5px;cursor:pointer;padding:0 4px;margin-left:4px;text-decoration:underline;text-underline-offset:2px}
.dsh-st-lightbox-abort-btn:hover{color:var(--dsw-alias-state-error-primary)}

/* Hide floating chat composer and width handles when the conversation-view
   gallery page is active. The right-sidebar variant (dsh-st-page-in-sidebar)
   is excluded: the native conversation runs beside it and needs its composer
   and the column handles untouched. */
[data-conversation-scroll]:has(.dsh-st-gallery-page:not(.dsh-st-page-in-sidebar)) [data-composer-seat]{display:none!important}
:has(> [data-conversation-scroll]:has(.dsh-st-gallery-page:not(.dsh-st-page-in-sidebar))) > [class*="widthHandle"],
:has(.dsh-st-gallery-page:not(.dsh-st-page-in-sidebar)) [class*="widthHandle"],
.root:has(.dsh-st-gallery-page:not(.dsh-st-page-in-sidebar)) [class*="widthHandle"]{display:none!important}
`
