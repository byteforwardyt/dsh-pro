/** Rich team conversation, seated in the native workspace Session frame. */
window.__ModuleLoader__.load({
  id: '@dsh-desktop/client-ui-supercode',
  factory: require => {
    const React = require('react'), h = React.createElement;
    const { MarkdownText, MarkdownDelegateProvider } = require('@deepseek-ai/dsh-client-ui-primitives');
    const { useEffect, useMemo, useRef, useState } = React;
    const markdownLabels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied', toolbarLabels: { codeLabel: 'Code', wrapLabel: 'Wrap lines', unwrapLabel: 'Unwrap lines' } }, footnotes: 'Footnotes' };
    const TERMINAL = new Set(['stopped', 'completed']);
    const TASK_STATES = ['backlog', 'ready', 'blocked', 'cancelled'];
    const CSS = `
.dsh-supercode{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font:14px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;-webkit-app-region:no-drag}
.dsh-supercode *{box-sizing:border-box}.dsh-supercode button,.dsh-supercode input,.dsh-supercode select,.dsh-supercode textarea{font:inherit;color:inherit}.dsh-supercode button{cursor:pointer}.dsh-supercode button:disabled{opacity:.4;cursor:default}.dsh-supercode :is(button,input,select,textarea):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
.dsh-supercode button:not(:where(.sc-rich button)){border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:transparent;padding:7px 12px}.dsh-supercode button:not(:where(.sc-rich button,.sc-primary)):hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dsh-supercode button.sc-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);border-color:transparent}.dsh-supercode button.sc-danger{color:var(--dsw-alias-state-error-primary,#d97878)}
.dsh-supercode input,.dsh-supercode select,.dsh-supercode textarea{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);min-width:0;max-width:100%}.dsh-supercode textarea{resize:vertical;min-height:76px}.dsh-supercode label{display:grid;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}.dsh-supercode small,.dsh-supercode .sc-muted{color:var(--dsw-alias-label-tertiary)}.dsh-supercode .sc-muted{margin:0}.dsh-supercode summary{cursor:pointer}.sc-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.sc-row label{flex:1;min-width:140px}.sc-stack{display:grid;gap:14px}.dsh-supercode button.sc-send{display:grid;place-items:center;border-radius:50%;width:36px;height:36px;flex:none;padding:0;font-size:24px;line-height:1}
.dsh-supercode .sc-agent-picker{color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:18px;padding:22px;width:min(780px,94vw);max-height:85vh;overflow:auto}.sc-agent-picker::backdrop{background:#0008}.sc-agent-picker>header{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px}.sc-agent-picker h2{margin:0;font-size:18px;font-weight:550}
.sc-team-form{display:grid;gap:12px}.sc-member-form{border:1px solid var(--dsw-alias-border-l2);border-radius:13px;padding:14px;display:grid;grid-template-columns:minmax(110px,1fr) minmax(160px,1.8fr) minmax(100px,1fr);gap:10px 14px;align-items:start}.sc-member-form header{display:flex;align-items:center;gap:9px;align-self:center}.sc-member-form header>div{display:grid}.sc-member-form header strong{font-size:13px}.sc-member-form header small{font-size:11px}.sc-member-form>small,.sc-member-form>p,.sc-member-form>div,.sc-member-form>.sc-advanced{grid-column:1/-1}.sc-member-form>label:nth-of-type(2){grid-column:3;grid-row:1}.sc-member-form textarea{min-height:65px}.sc-advanced{font-size:12px;color:var(--dsw-alias-label-secondary)}.sc-advanced>.sc-stack{margin-top:14px}.sc-advanced summary{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.sc-banner{padding:9px 18px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px}.sc-banner p{margin:0}.sc-banner [role=alert],.sc-error{color:var(--dsw-alias-state-error-primary,#d97878)}
.sc-room{display:flex;flex-direction:column;min-height:0;flex:1}.sc-person{display:flex;gap:8px;align-items:center;min-width:0}.sc-avatar{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;background:color-mix(in srgb,var(--sc-color,#7389a4) 13%,var(--dsw-alias-bg-layer-1));color:var(--sc-color,#7389a4);font-size:11px;font-weight:650;flex:none}.sc-person>div{display:grid;line-height:1.35}.sc-person strong{font-size:12px;font-weight:550;white-space:nowrap}.sc-person small{font-size:10px;white-space:nowrap}.sc-status{font-size:11px;border-radius:20px;padding:3px 8px;background:var(--dsw-alias-bg-layer-1);white-space:nowrap}.sc-usage{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 18px 8px}.sc-usage summary{width:max-content}.sc-usage p{margin:5px 0}.sc-messages{overflow:auto;flex:1;padding:25px clamp(18px,4vw,45px);display:flex;flex-direction:column;gap:24px;min-height:100px;scroll-behavior:smooth}.sc-message{width:100%;max-width:780px;align-self:center;display:grid;gap:7px;min-width:0}.sc-message header{display:flex;gap:7px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:11px}.sc-message header .sc-avatar{width:24px;height:24px;font-size:10px}.sc-message header strong{font-size:12px;color:var(--dsw-alias-label-primary);font-weight:600}.sc-message time{font-size:10px;color:var(--dsw-alias-label-tertiary)}.sc-message header .sc-task-ref{margin-left:auto;opacity:.6}.sc-bubble{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7;min-width:0}.sc-message.is-agent .sc-bubble{margin-left:31px;padding:12px 16px;border-radius:4px 18px 18px 18px;background:var(--dsw-alias-bg-layer-1);border-left:2px solid color-mix(in srgb,var(--sc-color) 45%,transparent)}.sc-message.is-user header{justify-content:flex-end}.sc-message.is-user .sc-bubble{justify-self:end;max-width:90%;padding:10px 16px;border-radius:17px;background:var(--dsw-alias-bg-layer-1)}.sc-message.is-system{font-size:12px;color:var(--dsw-alias-label-tertiary)}.sc-message.is-system .sc-bubble{padding:0 31px}.sc-rich{white-space:normal;overflow-wrap:anywhere;min-width:0}.sc-message .sc-rich>div{min-width:0}.sc-empty{padding:34px 20px;text-align:center;color:var(--dsw-alias-label-tertiary);margin:auto;max-width:500px}.sc-empty h2{font-size:18px;color:var(--dsw-alias-label-primary);margin:0 0 8px}.sc-empty p{margin:0}.sc-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.sc-board{border-left:1px solid var(--dsw-alias-border-l2);overflow:auto;padding:18px;background:var(--dsw-alias-bg-base);display:flex;flex-direction:column;gap:14px;min-width:0}.sc-board>header{display:flex;justify-content:space-between;gap:10px;align-items:center}.sc-board h2{font-size:14px;margin:0;font-weight:600}.sc-board>p{font-size:12px;margin:0}.sc-board>button{font-size:12px}.sc-task{border:1px solid var(--dsw-alias-border-l2);border-radius:11px;padding:12px;display:grid;gap:8px;flex:none}.sc-task h3{font-size:12px;overflow-wrap:anywhere;margin:0;font-weight:600}.sc-task p,.sc-task li{font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.sc-task>p{margin:0}.sc-task ul{margin:0;padding-left:17px}.sc-task header{display:flex;gap:8px;align-items:start;justify-content:space-between}.sc-task header button{font-size:11px;padding:2px 6px}.sc-task .sc-status{font-size:10px}.sc-task.is-done{border-color:color-mix(in srgb,#35a668 30%,var(--dsw-alias-border-l2))}.sc-task-form{display:grid;gap:9px}.sc-task-form input,.sc-task-form select,.sc-task-form textarea{width:100%;font-size:12px}.sc-task details,.sc-board>details{font-size:12px}.sc-board>details>details{margin-top:12px}.sc-board details .sc-task{margin-top:10px}
.dsh-supercode .sc-file-link{display:inline;border:0;border-radius:3px;padding:0;background:transparent;color:inherit;text-decoration:underline;text-underline-offset:3px;font:inherit;overflow-wrap:anywhere;text-align:left}.sc-activity{margin:0 0 0 31px;color:var(--dsw-alias-label-tertiary);font-size:11px}.sc-tool-line{display:flex;align-items:baseline;gap:6px;line-height:1.65}.sc-tool-line strong{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary)}.sc-tool-line span{overflow-wrap:anywhere}.sc-activity details{margin-top:4px;font-size:11px}.sc-activity ol{padding-left:18px;display:grid;gap:4px;margin:7px 0 0}
.dsh-supercode .sc-evidence{color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:20px;width:min(1000px,94vw);height:min(740px,88vh);max-width:none;max-height:none}.sc-evidence::backdrop{background:#0008}.sc-evidence-body{display:flex;flex-direction:column;height:100%;gap:14px}.sc-evidence header{display:flex;align-items:center;gap:12px;justify-content:space-between;flex:none}.sc-evidence h2{font-size:15px;overflow-wrap:anywhere;margin:0}.sc-evidence-content{overflow:auto;min-height:0;flex:1}.sc-evidence pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 ui-monospace,monospace;tab-size:2}.sc-evidence img{max-width:100%;height:auto}.sc-evidence .sc-highlight{display:block;background:color-mix(in srgb,#438cf8 18%,transparent)}.sc-diff-add{color:#38a76c}.sc-diff-remove{color:#e47777}
@media(max-width:1050px){}
@media(max-width:730px){.sc-board{border-left:0}.sc-member-form{grid-template-columns:1fr}.sc-member-form>label:nth-of-type(2){grid-column:auto;grid-row:auto}}
@media(prefers-reduced-motion:reduce){.sc-messages{scroll-behavior:auto}}
.sc-inline-board{max-height:40%;overflow:auto;flex:none}.sc-inline-board .sc-board{border:0;padding:14px 18px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.sc-inline-board .sc-board>header,.sc-inline-board .sc-board>p{grid-column:1/-1}.sc-checkpoint{display:flex;align-items:center;gap:12px;padding:12px 18px;background:var(--dsw-alias-bg-layer-1);font-size:12px}.sc-checkpoint p{margin:0;flex:1}.sc-avatar{border-radius:50%!important;background:radial-gradient(circle at 25% 15%,color-mix(in srgb,var(--sc-color) 55%,#fff),color-mix(in srgb,var(--sc-color) 70%,#18202c) 55%,color-mix(in srgb,var(--sc-color) 28%,#14151b));color:#fff;box-shadow:inset 0 0 0 1px #ffffff21;font-weight:600}.sc-avatar-stack{display:flex;align-items:center;padding:3px 0;flex:none}.sc-avatar-stack>button{position:relative;margin-left:-6px;border:2px solid var(--dsw-alias-bg-base)!important;border-radius:50%!important;padding:0!important;background:transparent!important;transition:transform .18s}.sc-avatar-stack>button:first-child{margin-left:0}.sc-avatar-stack>button:hover{transform:translateY(-3px);z-index:2}.sc-avatar-stack>button:focus-visible{z-index:3}.sc-avatar-stack>button[data-active=true]::after{content:'';position:absolute;inset:-3px;border:1px solid var(--sc-color);border-radius:50%;animation:sc-pulse 2s ease-in-out infinite}.sc-avatar-stack>button[aria-pressed=true]{outline:2px solid var(--sc-color);outline-offset:2px}
.sc-discussion{max-width:780px;width:100%;align-self:center;min-width:0}.sc-discussion-head{display:flex;align-items:center;gap:10px;padding:0 0 15px;position:relative}.dsh-supercode button.sc-discussion-toggle{padding:4px 0;border:0;display:flex;gap:7px;align-items:center;color:var(--dsw-alias-label-secondary);font-size:12px;background:transparent}.sc-discussion-toggle .sc-chevron{transition:transform .18s;font-size:15px}.sc-discussion-toggle[aria-expanded=true] .sc-chevron{transform:rotate(90deg)}.sc-discussion-head small{font-size:11px}.sc-discussion-body{display:flex;flex-direction:column;gap:22px}.sc-message.is-agent .sc-bubble{padding:10px 14px;border:0;border-radius:4px 18px 18px 18px;background:color-mix(in srgb,var(--sc-color) 3%,var(--dsw-alias-bg-layer-1))}.sc-message.is-agent header strong{color:color-mix(in srgb,var(--sc-color) 65%,var(--dsw-alias-label-primary))}.sc-message.is-user header{display:none}.sc-message.is-user .sc-bubble{max-width:min(88%,620px);border-radius:20px 20px 5px 20px}.sc-message.is-system .sc-bubble{padding:0 0 0 31px}.sc-message.is-result{padding-top:14px;border-top:1px solid var(--dsw-alias-border-l2);gap:13px}.sc-message.is-result .sc-bubble{padding:0 0 0 31px}.sc-result-label{font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}.sc-result-actions{padding-left:31px;display:flex;gap:6px}.sc-result-actions button{font-size:11px;padding:4px 8px}.sc-activity summary{display:flex;gap:6px;align-items:center;list-style:none}.sc-activity summary::before{content:'›';font-size:14px}.sc-activity details[open]>summary::before{transform:rotate(90deg)}.sc-activity ol{list-style:none;padding:0}.sc-active-line{display:flex;align-items:center;gap:8px;margin:2px 0 0 31px;color:var(--dsw-alias-label-tertiary);font-size:12px}.sc-active-line i{height:4px;width:4px;border-radius:50%;background:currentColor;animation:sc-pulse 1.5s ease-in-out infinite}.sc-member-card{width:min(360px,90vw)!important}.sc-member-card .sc-person{margin:10px 0 18px}.sc-member-card .sc-avatar{width:46px;height:46px;font-size:15px}.sc-member-card p{font-size:12px;overflow-wrap:anywhere}.sc-member-card>button{width:100%;margin-top:10px}.sc-member-card small{display:block}
@keyframes sc-pulse{0%,100%{opacity:.35}50%{opacity:1}}@media(max-width:730px){.sc-discussion-head{flex-wrap:wrap;gap:8px}.sc-message.is-agent .sc-bubble{margin-left:0}.sc-activity{margin-left:0}}@media(prefers-reduced-motion:reduce){.sc-avatar-stack>button,.sc-chevron{transition:none}.sc-avatar-stack>button[data-active=true]::after,.sc-active-line i{animation:none}}
.sc-discussion-body[hidden]{display:none}.dsh-supercode .sc-avatar,.dsh-supercode .sc-avatar-stack>button,.dsh-supercode .sc-send{corner-shape:round}.sc-discussion-head{position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base);padding-top:8px}.sc-messages{scroll-behavior:auto}
.sc-header-controls{display:flex;align-items:center;gap:10px;min-width:0;-webkit-app-region:no-drag}
.sc-header-controls button,.sc-header-controls summary{box-sizing:border-box;min-height:28px;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;border:0;background:transparent;border-radius:7px;padding:5px 8px;font-size:12px;white-space:nowrap}
.sc-mode-button{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:7px;padding:4px 6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.sc-mode-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sc-model-choice{max-width:260px!important;min-width:120px;text-overflow:ellipsis}.sc-model-editor-note{font-size:12px;color:var(--dsw-alias-label-secondary)}
.sc-header-controls button:hover,.sc-header-controls summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sc-header-controls .sc-avatar-stack{display:flex;gap:0}.sc-header-controls .sc-avatar-stack>button{padding:0;border-radius:50%;margin-left:-5px}.sc-header-controls .sc-avatar-stack>button:first-child{margin-left:0}.sc-header-controls .sc-avatar{width:24px;height:24px;font-size:9px}
.sc-header-controls .sc-usage{padding:0;position:relative}.sc-header-controls .sc-usage p{position:absolute;top:30px;right:0;z-index:50;padding:12px;width:270px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px #0003;white-space:normal}
[class~="wSkVaW_root"]:has(.sc-native-transcript) [class~="ZKlsPq_root"]{display:none!important}
.sc-checkpoint>div{flex:1;min-width:0}.sc-checkpoint details{margin-top:4px;color:var(--dsw-alias-label-tertiary)}.sc-checkpoint pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:150px;overflow:auto;font-size:11px}
@media(max-width:900px){.sc-header-controls{gap:4px}.sc-header-controls .sc-avatar-stack{display:none}}
.dsh-supercode.sc-native-transcript{height:auto;flex:1;min-height:0;background:transparent;font:inherit}
.sc-native-transcript .sc-messages{overflow:visible;padding:24px 24px 32px;min-height:0;flex:none}
.sc-native-transcript :is(.sc-message,.sc-discussion){max-width:min(100%,var(--dsh-chat-content-width,960px))}.sc-native-transcript .sc-discussion-head{position:static}
.dsh-supercode.sc-native-controls{height:auto;display:flex;flex-direction:row;align-items:center;background:transparent;font:inherit;gap:6px}
.sc-native-controls :is(select,button){font-size:12px}.sc-native-controls select{border:0;background:transparent;padding:5px 6px}
.sc-native-controls>div{display:flex;gap:6px;align-items:center}.sc-native-controls .sc-agent-picker{font:14px/1.55 -apple-system,BlinkMacSystemFont,sans-serif}
.sc-native-controls button:not(.sc-primary){border:0;padding:5px 7px}.sc-native-controls .sc-model-choice{max-width:200px!important}
.sc-native-tools .sc-header-controls .sc-avatar-stack{display:none}.sc-native-tools .sc-usage p{top:auto;bottom:30px}
`;
    const short = text => String(text || '').split(/\s+/).slice(0, 2).map(word => word[0]).join('').toUpperCase();
    const label = value => String(value || '').replace(/-/g, ' ');
    const colors = ['#4b91ed', '#ae7ae6', '#35a67c', '#dd9442', '#d97292'];
    const keyOf = member => JSON.stringify([member.provider, member.model]);
    const working = state => ['Planning', 'Working', 'Reviewing', 'Discussing'].includes(state);
    const duration = ms => ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.floor(ms / 1000) % 60}s` : `${Math.floor(Math.max(0, ms) / 1000)}s`;
    function AvatarStack({ members, states = {}, onSelect, selected }) {
      return h('div', { className: 'sc-avatar-stack', 'aria-label': 'Team members' }, members.map((member, index) => h('button', { key: member.id, type: 'button', style: { '--sc-color': colors[index % colors.length] },
        'aria-label': 'About ' + member.name, title: `${member.name} · ${member.model}${member.effort ? ' · ' + member.effort : ''}\n${states[member.id] || member.role}`, 'data-active': working(states[member.id]), 'aria-pressed': selected === member.id, onClick: () => onSelect?.(member) }, h('span', { className: 'sc-avatar', 'aria-hidden': true }, short(member.name)))));
    }
    const effortChoices = model => {
      const values = model?.reasoning?.efforts || model?.reasoningEfforts || [];
      return Array.isArray(values) ? values.map(value => typeof value === 'string' ? { id: value, name: value } : value).filter(value => value?.id) : [];
    };
    const efforts = model => {
      return effortChoices(model).map(value => value.id);
    };
    function availableModels(data, member) {
      return (data.catalog || []).flatMap(provider => (provider.models || []).filter(model => !Object.hasOwn(data.selections || {}, provider.id)
        || data.selections[provider.id].includes(model.id) || (member?.provider === provider.id && member?.model === model.id))
        .map(model => ({ ...model, provider: provider.id, providerName: provider.label || provider.name || provider.id })));
    }
    function initialMembers() {
      return [['lead', 'Lead', 'Coordinator'], ['builder', 'Builder', 'Implementation'], ['reviewer', 'Reviewer', 'Review and verification']].map(([id, name, role]) => ({
        id, name, role, provider: '', model: '', instructions: '',
      }));
    }
    function TeamModelSelect({ data, members, onChange, disabled }) {
      const same = members.length && members.every(member => keyOf(member) === keyOf(members[0]));
      const current = same && members[0].model ? keyOf(members[0]) : '';
      const models = availableModels(data, same ? members[0] : null);
      return h('select', { className: 'sc-model-choice', 'aria-label': 'Team model', value: current, disabled,
        title: 'Choose one model for the whole team, or customize each agent in Models and agents.',
        onChange: event => { const selected = models.find(model => JSON.stringify([model.provider, model.id]) === event.target.value);
          if (selected) onChange(members.map(member => ({ ...member, provider: selected.provider, model: selected.id, effort: undefined }))); } },
        h('option', { value: '', disabled: true }, members.some(member => member.model) ? 'Different models per agent' : 'Choose model'),
        current && !models.some(model => JSON.stringify([model.provider, model.id]) === current) ? h('option', { value: current, disabled: true }, members[0].model + ' · unavailable') : null,
        models.map(model => h('option', { key: JSON.stringify([model.provider, model.id]), value: JSON.stringify([model.provider, model.id]) }, `${model.providerName} · ${model.name || model.id}`)));
    }
    async function request(path, body, signal) {
      const response = await fetch('/dsh-supercode' + path, { credentials: 'same-origin', signal,
        ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
      const result = await response.json();
      if (!response.ok) {
        const error = new Error(result.error || 'SuperCode could not complete that request.');
        error.status = response.status;
        error.revisionConflict = response.status === 409 && /(?:room|task|board).*changed|revision/i.test(error.message);
        throw error;
      }
      return result;
    }
    function Icon({ size = 18 }) {
      return h('svg', { className: 'sc-mode-icon', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('circle', { cx: 12, cy: 7, r: 3 }), h('circle', { cx: 4.5, cy: 10, r: 2 }), h('circle', { cx: 19.5, cy: 10, r: 2 }),
        h('path', { d: 'M7 20v-2a5 5 0 0 1 10 0v2M1 20v-2a3.5 3.5 0 0 1 4-3.5M23 20v-2a3.5 3.5 0 0 0-4-3.5', strokeLinecap: 'round' }));
    }
    function evidenceTarget(value, workspace) {
      if (typeof value !== 'string' || !workspace?.cwd) return null;
      let path = value.trim().replace(/^<|>$/g, ''), line;
      const suffix = path.match(/(?::|#L)(\d+)(?::\d+)?$/);
      if (suffix) { line = Number(suffix[1]); path = path.slice(0, -suffix[0].length); }
      if (!path || /[\x00-\x1f:*?|<>;\\]/.test(path) || /^[a-z][a-z\d+.-]*:/i.test(path)) return null;
      const normalize = input => { const parts = []; for (const part of input.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); } return '/' + parts.join('/'); };
      const root = normalize(workspace.cwd), resolved = normalize(path.startsWith('/') ? path : root + '/' + path);
      return resolved.startsWith(root + '/') ? { type: 'file', path: resolved, ...(line > 0 ? { line } : {}) } : null;
    }
    function EvidenceText({ text, workspace, onOpen }) {
      const value = String(text || ''), parts = []; let end = 0;
      const pattern = /(?:https?|file|javascript|data):[^\s]+|\[([^\]\n]+)\]\((<?[^)\n]+>?)\)|`([^`\n]+)`|(?:\/|\.\.?\/)?(?:[A-Za-z_][\w@+.-]*\/)*[A-Za-z_][\w@+.-]*\.[A-Za-z][\w]{0,11}(?::\d+(?::\d+)?)?/g;
      for (const match of value.matchAll(pattern)) {
        const target = evidenceTarget(match[2] || match[3] || match[0], workspace);
        if (!target) continue;
        parts.push(value.slice(end, match.index), h('button', { key: match.index, type: 'button', className: 'sc-file-link', title: 'Read ' + target.path,
          onClick: () => onOpen(target) }, match[1] || match[3] || match[0]));
        end = match.index + match[0].length;
      }
      parts.push(value.slice(end)); return h(React.Fragment, null, ...parts);
    }
    function RichMessage({ text, workspace, onOpen, streaming = false }) {
      const pathImages = useMemo(() => ({ resolve: path => {
        const target = evidenceTarget(path, { cwd: workspace?.cwd });
        return target && /\.(png|jpe?g|gif|webp)$/i.test(target.path) ? new URL('/dsh-files/raw?path=' + encodeURIComponent(target.path), document.baseURI).href : undefined;
      } }), [workspace?.cwd]);
      return h('div', { className: 'sc-rich' }, h(MarkdownDelegateProvider, {
        openFile: (path, options) => {
          const target = evidenceTarget(path, workspace);
          if (target) onOpen({ ...target, ...(Number.isInteger(options?.line) && options.line > 0 ? { line: options.line } : {}) });
        },
        openExternalLink: href => { try { const url = new URL(href); if (['http:', 'https:'].includes(url.protocol)) window.open(url.href, '_blank', 'noopener,noreferrer'); } catch (_) { /* Invalid links remain inert. */ } },
      }, h(MarkdownText, { text: String(text || ''), labels: markdownLabels, variant: 'body', streaming, pathImages })));
    }
    function EvidencePanel({ target, workspace, onClose, onOpen }) {
      const dialog = useRef(null), content = useRef(null), [state, setState] = useState({ loading: true });
      useEffect(() => { dialog.current?.showModal(); return () => { if (dialog.current?.open) dialog.current.close(); }; }, []);
      useEffect(() => {
        const controller = new AbortController(); setState({ loading: true });
        const url = target.type === 'diff' ? '/dsh-files/git?root=' + encodeURIComponent(workspace.cwd) : '/dsh-files/read?path=' + encodeURIComponent(target.path);
        void fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
          const data = await response.json(); if (!response.ok) throw Error(data.error || 'Could not open this evidence.');
          if (!controller.signal.aborted) setState({ loading: false, data });
        }).catch(error => { if (!controller.signal.aborted) setState({ loading: false, error: error.message }); });
        return () => controller.abort();
      }, [target.path, target.type, workspace.cwd]);
      useEffect(() => { content.current?.querySelector?.('.sc-highlight')?.scrollIntoView?.({ block: 'center' }); }, [state.data]);
      const data = state.data, source = target.type === 'diff' && data ? 'WORKING CHANGES\n' + (data.workingDiff || 'No tracked working changes.') + '\n\nSTAGED CHANGES\n' + (data.stagedDiff || 'No staged changes.') : data?.text;
      return h('dialog', { className: 'sc-evidence', ref: dialog, 'aria-label': 'Evidence viewer', onCancel: e => { e.preventDefault(); onClose(); } },
        h('div', { className: 'sc-evidence-body' }, h('header', null, h('h2', null, target.type === 'diff' ? 'Current project changes' : target.path), h('button', { type: 'button', onClick: () => onClose() }, 'Close evidence')),
          h('small', null, target.type === 'diff' ? 'Current Git changes, including any edits made before this run. Untracked files are listed below.' : 'Current file contents · read only'),
          h('div', { className: 'sc-evidence-content', ref: content }, state.loading ? h('p', { role: 'status' }, 'Loading evidence…') : state.error ? h('p', { role: 'alert' }, state.error)
            : typeof source === 'string' ? h(React.Fragment, null, source.length > 200000 ? h('p', { role: 'status' }, 'Showing the first 200,000 characters.') : null,
              h('pre', null, source.slice(0, 200000).split('\n').map((line, index) => h('span', { key: index, className: target.line === index + 1 ? 'sc-highlight' : target.type === 'diff' ? line.startsWith('+') ? 'sc-diff-add' : line.startsWith('-') ? 'sc-diff-remove' : undefined : undefined }, line + '\n'))),
              target.type === 'diff' ? (data.files || []).filter(file => file.untracked).map(file => h('p', { key: file.path }, 'Untracked: ', h(EvidenceText, { text: file.path, workspace, onOpen }))) : null)
              : data?.kind === 'binary' && /\.(png|jpe?g|gif|webp)$/i.test(target.path) ? h('img', { src: '/dsh-files/raw?path=' + encodeURIComponent(target.path), alt: target.path.split('/').at(-1) })
                : h('p', null, data?.kind === 'too-large' ? 'This file exceeds the file viewer’s size limit.' : 'This binary artifact has no inline text preview.'))));
    }
    function groupMessages(messages) {
      const rows = [], pending = new Map(), last = new Map();
      const key = entry => JSON.stringify([entry.runId || '', entry.memberId, entry.taskId || '']);
      messages.forEach((entry, index) => {
        const id = key(entry);
        if (entry.kind === 'tool') { if (!pending.has(id)) pending.set(id, []); pending.get(id).push({ entry, index }); return; }
        const row = { message: entry, index, activity: entry.kind === 'agent' ? (pending.get(id) || []).map(item => item.entry) : [] };
        if (entry.kind === 'agent') { pending.delete(id); last.set(id, row); }
        rows.push(row);
      });
      for (const [id, items] of pending) {
        const previous = last.get(id);
        if (previous) previous.activity.push(...items.map(item => item.entry));
        else rows.push({ message: items[0].entry, index: items.at(-1).index, activity: items.map(item => item.entry), activityOnly: true });
      }
      return rows.sort((a, b) => a.index - b.index);
    }
    function conversationGroups(room) {
      const groups = [];
      for (const row of groupMessages(room.messages)) {
        const runId = row.message.runId || room.runId, previous = groups.at(-1);
        if (!previous || previous.runId !== runId || row.message.kind === 'user') groups.push({ id: row.message.id, runId, rows: [row] });
        else previous.rows.push(row);
      }
      return groups.map(group => {
        const run = group.runId === room.runId ? room : room.history?.find(item => item.runId === group.runId);
        const final = run?.status === 'completed' ? room.messages.findLast(item => (item.runId || room.runId) === group.runId && item.kind === 'agent' && item.memberId === run.leadId) : null;
        return { ...group, run: run || room, final: group.rows.find(row => row.message.id === final?.id) };
      });
    }
    function MemberForm({ member, index, data, details, onRetry, onChange }) {
      const models = availableModels(data, member), selected = models.find(model => model.provider === member.provider && model.id === member.model);
      const choices = details?.status === 'ready' ? effortChoices(details.model) : [], levels = choices.map(choice => choice.id);
      const incompatible = details?.status === 'ready' && member.effort && !levels.includes(member.effort);
      const update = change => onChange({ ...member, ...change });
      return h('section', { className: 'sc-member-form', 'aria-label': 'Configure ' + member.name },
        h('header', null, h('span', { className: 'sc-avatar', style: { '--sc-color': colors[index] } }, short(member.name)),
          h('div', null, h('strong', null, member.name), h('small', null, member.role))),
        h('label', null, 'Model', h('select', { value: keyOf(member), required: true, onChange: e => { const [provider, model] = JSON.parse(e.target.value); update({ provider, model, effort: undefined }); } },
          !selected ? h('option', { value: keyOf(member), disabled: true }, member.model ? `${member.provider} / ${member.model} · unavailable` : 'Choose a connected model') : null,
          models.map(model => h('option', { key: JSON.stringify([model.provider, model.id]), value: JSON.stringify([model.provider, model.id]) }, `${model.providerName} · ${model.name || model.id}`)))),
        selected && (!details || details.status === 'loading') ? h('small', { role: 'status' }, 'Checking this model’s supported settings…') : null,
        details?.status === 'error' ? h('div', null, h('p', { role: 'alert', className: 'sc-error' }, 'Could not resolve this model. ' + details.error),
          h('button', { type: 'button', onClick: onRetry }, 'Retry model details')) : null,
        incompatible ? h('p', { role: 'alert', className: 'sc-error' }, 'The saved effort is no longer supported. Choose an available effort or Model default.') : null,
        levels.length || member.effort ? h('label', null, 'Reasoning effort', h('select', { value: member.effort || '', disabled: details?.status !== 'ready', onChange: e => update({ effort: e.target.value || undefined }) },
          h('option', { value: '' }, 'Model default'), member.effort && !levels.includes(member.effort) ? h('option', { value: member.effort, disabled: true }, member.effort + ' · unavailable') : null,
          choices.map(choice => h('option', { key: choice.id, value: choice.id, title: choice.description }, choice.name || choice.id)))) : null,
        h('details', { className: 'sc-advanced' }, h('summary', null, 'Advanced'), h('div', { className: 'sc-stack' },
          h('label', null, 'Name', h('input', { value: member.name, required: true, maxLength: 40, onChange: e => update({ name: e.target.value }) })),
          h('label', null, 'Role', h('input', { value: member.role, required: true, maxLength: 60, onChange: e => update({ role: e.target.value }) })),
          h('label', null, 'Instructions (optional)', h('textarea', { value: member.instructions || '', maxLength: 4000, onChange: e => update({ instructions: e.target.value }) })))));
    }
    function useTeamModels(data, members) {
      const [modelDetails, setModelDetails] = useState({}), [modelRefresh, setModelRefresh] = useState(0);
      const modelKeys = JSON.stringify([...new Set(members.filter(member => member.provider && member.model).map(keyOf))].sort());
      useEffect(() => {
        const controller = new AbortController(), keys = JSON.parse(modelKeys);
        setModelDetails(Object.fromEntries(keys.map(key => [key, { status: 'loading' }])));
        for (const key of keys) {
          const [provider, model] = JSON.parse(key);
          void request('/model?provider=' + encodeURIComponent(provider) + '&model=' + encodeURIComponent(model), undefined, controller.signal)
            .then(model => { if (!controller.signal.aborted) setModelDetails(previous => ({ ...previous, [key]: { status: 'ready', model } })); })
            .catch(error => { if (!controller.signal.aborted) setModelDetails(previous => ({ ...previous, [key]: { status: 'error', error: error.message } })); });
        }
        return () => controller.abort();
      }, [modelKeys, modelRefresh, data.catalog]);
      const valid = members.every(member => member.name.trim() && member.role.trim() && availableModels(data, member).some(model => model.id === member.model && model.provider === member.provider)
        && modelDetails[keyOf(member)]?.status === 'ready' && (!member.effort || efforts(modelDetails[keyOf(member)].model).includes(member.effort)));
      return { modelDetails, valid, retry: () => setModelRefresh(value => value + 1) };
    }
    function TeamEditor({ room, data, busy, onSave, onClose }) {
      const [members, setMembers] = useState((room.nextTeam?.members || room.members).map(member => ({ ...member })));
      const { modelDetails, valid, retry } = useTeamModels(data, members);
      return h(AgentPicker, { onClose }, h('p', { className: 'sc-model-editor-note' }, 'Choose models for the next plan. Saving does not run them or change your current team. You can then replan this goal or send a New goal; files and history are preserved.'),
        h(TeamModelSelect, { data, members, onChange: setMembers, disabled: busy }),
        members.map((member, index) => h(MemberForm, { key: member.id, member, index, data, details: modelDetails[keyOf(member)], onRetry: retry,
          onChange: value => setMembers(previous => previous.map(item => item.id === member.id ? value : item)) })),
        h('button', { type: 'button', className: 'sc-primary', disabled: busy || !valid,
          onClick: () => onSave({ members, leadId: room.nextTeam?.leadId || room.leadId }) }, 'Save models'));
    }
    function Setup({ data, room, busy, onCancel, workspaceId, draft, onDraft }) {
      const [members, setMembers] = useState(() => draft?.members || room?.members || initialMembers(data));
      const [leadId, setLead] = useState(draft?.leadId || room?.leadId || 'lead'), [minutes, setMinutes] = useState(draft?.minutes || room?.limits.minutes || 60), [calls, setCalls] = useState(draft?.calls || room?.limits.calls || 200);
      const [showAgents, setShowAgents] = useState(false);
      const { modelDetails, valid, retry } = useTeamModels(data, members);
      const validLimits = Number.isInteger(Number(minutes)) && Number(minutes) >= 1 && Number(minutes) <= 240 && Number.isInteger(Number(calls)) && Number(calls) >= 1 && Number(calls) <= 1000;
      useEffect(() => { onDraft?.({ members, leadId, minutes, calls, ready: !!workspaceId && valid && validLimits }); }, [members, leadId, minutes, calls, workspaceId, valid, validLimits]);
      useEffect(() => { if (draft?.showAgents) { setShowAgents(true); onDraft?.({ showAgents: false }); } }, [draft?.showAgents]);
      const resizeTeam = size => {
        const next = members.slice(0, size), defaults = initialMembers(data);
        const shared = members[0]?.model && members.every(member => keyOf(member) === keyOf(members[0])) ? { provider: members[0].provider, model: members[0].model } : {};
        while (next.length < size) { const index = next.length; next.push({ ...(defaults[index] || defaults[1]), ...shared, id: defaults[index]?.id || 'member-' + crypto.randomUUID(), name: defaults[index]?.name || 'Specialist ' + (index - 2), role: defaults[index]?.role || 'Research and support' }); }
        setMembers(next); if (!next.some(member => member.id === leadId)) setLead(next[0].id);
      };
      return h('div', { className: 'sc-team-controls' },
        h(TeamModelSelect, { data, members, onChange: setMembers, disabled: busy }),
        h('button', { type: 'button', disabled: busy, onClick: () => setShowAgents(true), 'aria-label': 'Models and agents', title: 'Choose each agent’s model and effort' }, h(Icon, { size: 16 }), members.length + ' agents'),
        showAgents ? h(AgentPicker, { onClose: () => setShowAgents(false) },
          h('label', { htmlFor: 'sc-agent-count' }, 'Agents'), h('select', { id: 'sc-agent-count', value: members.length, onChange: e => resizeTeam(Number(e.target.value)) }, [2, 3, 4, 5].map(size => h('option', { key: size, value: size }, size + ' agents'))),
          members.map((member, index) => h(MemberForm, { key: member.id, member, index, data, details: modelDetails[keyOf(member)], onRetry: retry, onChange: value => setMembers(members.map(item => item.id === member.id ? value : item)) })),
          h('details', { className: 'sc-advanced' }, h('summary', null, 'Advanced'), h('div', { className: 'sc-stack' },
            h('label', null, 'Team lead', h('select', { value: leadId, onChange: e => setLead(e.target.value) }, members.map(member => h('option', { key: member.id, value: member.id }, member.name)))),
            h('label', null, 'Time limit (minutes)', h('input', { type: 'number', value: minutes, min: 1, max: 240, onChange: e => setMinutes(e.target.value) })),
            h('label', null, 'Model call limit', h('input', { type: 'number', value: calls, min: 1, max: 1000, onChange: e => setCalls(e.target.value) })))),
          !valid || !validLimits ? h('p', { role: 'status' }, 'Resolve the selected model settings and limits before sending.') : null) : null);
    }
    function AgentPicker({ children, onClose }) {
      const dialog = useRef(null);
      useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
      return h('dialog', { className: 'sc-agent-picker', ref: dialog, 'aria-label': 'Group agents', onCancel: e => { e.preventDefault(); onClose(); } },
        h('header', null, h('h2', null, 'Who’s in the group?'), h('button', { type: 'button', onClick: onClose }, 'Done')), h('div', { className: 'sc-stack' }, children));
    }
    function TaskEditor({ task, room, busy, onSave, onCancel }) {
      const [draft, setDraft] = useState(() => ({ title: '', ownerId: room.leadId, status: 'backlog', dependencies: [], criteria: '', evidence: [], ...task }));
      const [dependencies, setDependencies] = useState((task?.dependencies || []).join(', '));
      const change = update => setDraft({ ...draft, ...update });
      return h('form', { className: 'sc-task-form', onSubmit: e => { e.preventDefault(); onSave({ ...draft, dependencies: dependencies.split(',').map(value => value.trim()).filter(Boolean) }); } },
        h('label', null, 'Task title', h('input', { required: true, value: draft.title, maxLength: 200, onChange: e => change({ title: e.target.value }) })),
        h('label', null, 'Owner', h('select', { value: draft.ownerId, onChange: e => change({ ownerId: e.target.value }) }, room.members.map(member => h('option', { key: member.id, value: member.id }, member.name)))),
        h('label', null, 'Status', h('select', { value: draft.status, onChange: e => change({ status: e.target.value }) }, TASK_STATES.map(status => h('option', { key: status, value: status }, label(status))))),
        h('label', null, 'Success criteria', h('textarea', { value: draft.criteria, required: true, maxLength: 4000, onChange: e => change({ criteria: e.target.value }) })),
        h('label', null, 'Dependencies (task IDs, separated by commas)', h('input', { value: dependencies, onChange: e => setDependencies(e.target.value) })),
        h('div', { className: 'sc-row' }, h('button', { type: 'button', disabled: busy, onClick: onCancel }, 'Cancel'), h('button', { className: 'sc-primary', disabled: busy || !draft.title.trim() || !draft.criteria.trim() }, 'Save task')));
    }
    function TaskCard({ task, room, busy, editable, onSave, onOpen }) {
      const [editing, setEditing] = useState(false), member = room.members.find(item => item.id === task.ownerId);
      return h('article', { className: 'sc-task is-' + task.status, 'aria-label': task.title },
        editing && editable ? h(TaskEditor, { task, room, busy, onCancel: () => setEditing(false), onSave: async value => { if (await onSave(value)) setEditing(false); } }) : h(React.Fragment, null,
          h('header', null, h('h3', null, task.title), editable ? h('button', { onClick: () => setEditing(true), disabled: busy, 'aria-label': 'Edit task: ' + task.title }, 'Edit') : null),
          h('div', { className: 'sc-row' }, h('span', { className: 'sc-status' }, label(task.status)), h('small', null, member?.name || 'Unassigned')),
          h('small', null, task.id), task.criteria ? h(RichMessage, { text: task.criteria, workspace: room.workspace, onOpen }) : null,
          task.dependencies?.length ? h('small', null, 'After: ' + task.dependencies.join(', ')) : null,
          task.evidence?.length ? h('ul', null, task.evidence.map((item, i) => h('li', { key: i }, h(RichMessage, { text: item, workspace: room.workspace, onOpen })))) : null,
          task.review ? h('details', null, h('summary', null, 'Review: ' + label(task.review.verdict) + ' · ' + (room.members.find(item => item.id === task.review.memberId)?.name || 'Reviewer')),
            h('ul', null, (task.review.evidence || []).map((item, i) => h('li', { key: i }, h(RichMessage, { text: item, workspace: room.workspace, onOpen }))))) : null));
    }
    function PreviousRuns({ room, onOpen }) {
      if (!room.history?.length) return null;
      return h('details', { className: 'sc-previous-runs' }, h('summary', null, 'Previous runs (' + room.history.length + ')'),
        room.history.map((run, index) => h('details', { key: run.runId, className: 'sc-stack' }, h('summary', null, `Run ${index + 1} · ${label(run.status)} · ${run.goal}`),
          h('p', { className: 'sc-muted' }, run.members.map(member => `${member.name} · ${member.provider} / ${member.model}${member.effort ? ' · ' + member.effort : ''}`).join('\n')),
          (run.tasks || []).map(task => h(TaskCard, { key: task.id, task, room: { ...room, members: run.members }, editable: false, busy: false, onOpen })))));
    }
    function Board({ room, busy, command, onOpen }) {
      const [adding, setAdding] = useState(false), editable = ['draft', 'awaiting-approval', 'paused', 'blocked'].includes(room.status);
      const save = task => command('task', { task });
      return h('aside', { className: 'sc-board', 'aria-label': 'Task board' },
        h('header', null, h('h2', null, 'Task board'), h('small', null, `${room.tasks.filter(task => task.status === 'done').length}/${room.tasks.length} done`)),
        h('button', { type: 'button', onClick: () => onOpen({ type: 'diff' }) }, 'Current changes'),
        room.status === 'awaiting-approval' ? h('p', { className: 'sc-muted' }, 'Review or edit the proposed tasks, then approve the plan.') : null,
        !room.tasks.length ? h('p', { className: 'sc-muted' }, 'The team’s plan will appear here. Tasks track ownership, dependencies, and verification.') : null,
        room.tasks.map(task => h(TaskCard, { key: task.id, task, room, busy, editable: editable && TASK_STATES.includes(task.status), onSave: save, onOpen })),
        adding && editable ? h('div', { className: 'sc-task' }, h(TaskEditor, { room, busy, onCancel: () => setAdding(false), onSave: async task => { if (await save(task)) setAdding(false); } }))
          : editable ? h('button', { disabled: busy, onClick: () => setAdding(true) }, 'Add task') : null,
        h(PreviousRuns, { room, onOpen }));
    }
    function Messages({ room, onOpen, onMember }) {
      const scroll = useRef(null), follow = useRef(true), lastStatus = useRef(room.status);
      const [collapsed, setCollapsed] = useState(() => Object.fromEntries(conversationGroups(room).filter(group => group.run.status === 'completed').map(group => [group.id, true]))), [copied, setCopied] = useState(''), [copyError, setCopyError] = useState('');
      const groups = conversationGroups(room);
      useEffect(() => {
        const viewport = scroll.current?.closest?.('[data-conversation-scroll]');
        if (!viewport) return;
        const track = () => { follow.current = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 100; };
        viewport.addEventListener('scroll', track, { passive: true });
        return () => viewport.removeEventListener('scroll', track);
      }, []);
      useEffect(() => {
        if (room.status === 'completed' && lastStatus.current !== 'completed' && follow.current) setCollapsed(previous => ({ ...previous, [groups.at(-1)?.id]: true }));
        lastStatus.current = room.status;
        const viewport = scroll.current?.closest?.('[data-conversation-scroll]') || scroll.current;
        if (follow.current && viewport) viewport.scrollTop = viewport.scrollHeight;
      }, [room.status, room.messages.length, room.messages.at(-1)?.text]);
      const render = ({ message, activity, activityOnly }, result = false) => {
          const roster = message.runId && message.runId !== room.runId ? room.history?.find(run => run.runId === message.runId)?.members : room.members;
          const member = roster?.find(item => item.id === message.memberId), time = new Date(message.createdAt);
          const recipientName = message.recipient === 'team' ? 'team' : message.recipient === 'lead' ? 'lead' : roster?.find(item => item.id === message.recipient)?.name;
          const color = member ? colors[roster.indexOf(member) % colors.length] : undefined;
          return h('article', { key: message.id, className: 'sc-message is-' + (result ? 'result' : message.kind), style: color ? { '--sc-color': color } : undefined },
            message.kind !== 'system' ? h('header', null,
              member ? h('span', { className: 'sc-avatar', 'aria-hidden': true }, short(member.name)) : null,
              h('strong', null, message.kind === 'user' ? 'You' : member?.name || 'Team'),
              result ? h('span', { className: 'sc-result-label' }, 'Team result') : null,
              recipientName ? h('span', { className: 'sc-recipient' }, '→ ' + recipientName) : null,
              !Number.isNaN(time.getTime()) ? h('time', { dateTime: time.toISOString() }, time.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })) : null,
              message.taskId ? h('span', { className: 'sc-task-ref', title: message.taskId }, message.taskId.slice(0, 8)) : null) : null,
            !activityOnly ? h('div', { className: 'sc-bubble' }, h(message.kind === 'user' ? EvidenceText : RichMessage, { text: message.text, workspace: room.workspace, onOpen, streaming: !!message.streaming })) : null,
            activity.length ? h('div', { className: 'sc-activity', 'aria-label': 'Tool activity' },
              h('details', null, h('summary', null, activity.length + ' tool actions', h('span', { className: 'sc-muted' }, '· ' + (activity.at(-1).name || 'Tool'))),
                h('ol', null, activity.map(item => h('li', { key: item.id, className: 'sc-tool-line' }, h('strong', null, item.name || 'Tool'), h('span', null, '· ' + item.text)))))) : null,
            result ? h('div', { className: 'sc-result-actions' }, h('button', { type: 'button', onClick: async () => { try { await navigator.clipboard.writeText(message.text); setCopied(message.id); setCopyError(''); } catch (_) { setCopyError('Could not copy this response. Try selecting the text.'); } } }, copied === message.id ? 'Copied' : 'Copy response'), copyError ? h('span', { role: 'alert' }, copyError) : null) : null);
      };
      return h('div', { className: 'sc-messages', ref: scroll, role: 'log', 'aria-label': 'Team conversation', 'aria-live': 'polite', 'aria-relevant': 'additions',
        onScroll: e => { const el = e.currentTarget; follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; } },
        !room.messages.length ? h('div', { className: 'sc-empty' }, h('h2', null, 'Your team is ready'), h('p', null, 'Start with Plan. Your lead will propose tasks for you to review before the team begins.')) : null,
        groups.map((group, index) => {
          const current = group.runId === room.runId && index === groups.length - 1, active = current && ['planning', 'running', 'discussing'].includes(room.status);
          const rows = group.rows.filter(row => row.message.kind !== 'user' && row !== group.final), open = !collapsed[group.id];
          const status = current ? room.chatOnly && room.status === 'draft' ? 'Team conversation' : room.status === 'planning' ? 'Team planning' : room.status === 'running' ? 'Team working' : room.status === 'awaiting-approval' ? 'Plan ready for you' : room.status === 'completed' ? 'Team conversation' : label(room.status) : 'Team conversation';
          const workingNames = active ? room.members.filter(member => working(room.memberStates?.[member.id])).map(member => member.name) : [];
          return h(React.Fragment, { key: group.id }, group.rows.filter(row => row.message.kind === 'user').map(row => render(row)),
            rows.length || current ? h('section', { className: 'sc-discussion', 'aria-label': 'Agent discussion' },
              h('div', { className: 'sc-discussion-head' }, h(AvatarStack, { members: group.run.members, states: active ? room.memberStates : {}, onSelect: onMember }),
                h('button', { type: 'button', className: 'sc-discussion-toggle', 'aria-expanded': open, 'aria-controls': 'discussion-' + group.id, onClick: () => setCollapsed(previous => ({ ...previous, [group.id]: open })) },
                  status, h('span', { className: 'sc-chevron', 'aria-hidden': true }, '›')), h('small', { title: 'Active team runtime, excluding pauses' }, duration(group.run.usage?.activeMs || 0))),
              h('div', { className: 'sc-discussion-body', id: 'discussion-' + group.id, hidden: !open }, rows.map(row => render(row)),
                workingNames.length ? h('div', { className: 'sc-active-line', role: 'status' }, h('i', { 'aria-hidden': true }), workingNames.join(' & ') + ' ' + (room.status === 'planning' ? 'investigating…' : room.status === 'discussing' ? 'replying…' : 'working…')) : null)) : null,
            group.final ? render(group.final, true) : null);
        }));
    }
    function MemberCard({ member, room, onClose, onMessage }) {
      const dialog = useRef(null), index = room.members.findIndex(item => item.id === member.id);
      useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
      return h('dialog', { ref: dialog, className: 'sc-agent-picker sc-member-card', 'aria-label': 'About ' + member.name, onCancel: e => { e.preventDefault(); onClose(); } },
        h('header', null, h('h2', null, 'Agent'), h('button', { type: 'button', onClick: onClose }, 'Close')),
        h('div', { className: 'sc-person' }, h('span', { className: 'sc-avatar', style: { '--sc-color': colors[Math.max(0, index)] } }, short(member.name)), h('div', null, h('strong', null, member.name), h('small', null, member.role))),
        h('small', null, 'Model'), h('p', null, member.provider + ' / ' + member.model, member.effort ? ' · ' + member.effort : ''),
        h('button', { type: 'button', className: 'sc-primary', disabled: index < 0, onClick: () => onMessage(member.id) }, 'Message ' + member.name));
    }
    function roomNotice(room) {
      const reason = String(room.reason || '');
      if (/refresh_token_expired|session has expired|OAuth refresh failed|token refresh failed/i.test(reason)) {
        const provider = /openai-codex|OpenAI Codex/i.test(reason) ? 'OpenAI Codex' : 'Your model provider';
        return { text: `${provider} needs you to sign in again. Reconnect it in Settings → Accounts, then continue this chat.`, detail: reason, action: 'Continue after reconnecting' };
      }
      if (/api.?key|credentials|unauthorized|authentication|\b401\b/i.test(reason)) return { text: 'A team member’s model connection needs attention. Check Settings → Accounts, then continue this chat.', detail: reason, action: 'Continue after reconnecting' };
      return { text: reason && !/[{}]/.test(reason) ? reason : 'This team is paused. Check the details before continuing.', detail: /[{}]/.test(reason) ? reason : '', action: 'Continue' };
    }
    function RoomHeader({ room, showTasks, onTasks, onMember }) {
      const usage = room.usage || {};
      return h('div', { className: 'sc-header-controls', 'aria-label': 'SuperCode team controls' },
        h(AvatarStack, { members: room.members, states: room.memberStates, onSelect: onMember }),
        h('button', { type: 'button', 'aria-expanded': !!showTasks, onClick: onTasks }, 'Tasks', room.tasks.length ? ` · ${room.tasks.filter(task => task.status === 'done').length}/${room.tasks.length}` : ''),
        h('details', { className: 'sc-usage', title: `${usage.calls || 0} total model calls` }, h('summary', null, 'Usage'), h('p', null,
          `${Math.max(0, (usage.calls || 0) - (room.checkpoint?.calls || 0))}/${room.limits.calls} calls · ${Math.floor(Math.max(0, (usage.activeMs || 0) - (room.checkpoint?.activeMs || 0)) / 60000)}/${room.limits.minutes} min · ${(usage.input || 0).toLocaleString()} input / ${(usage.output || 0).toLocaleString()} output tokens`,
          usage.cost != null ? ` · $${Number(usage.cost).toFixed(3)}` : ' · Cost unavailable')));
    }
    function Room({ room, data = { catalog: [] }, busy, command, draft, onDraft, presentation = {}, onPresentation = () => {}, nativePart = 'transcript' }) {
      const [evidence, setEvidence] = useState(null);
      const recipient = draft?.recipient || 'lead', newGoal = !!draft?.newGoal;
      const setRecipient = recipient => onDraft?.({ recipient });
      const { showTasks = false, selectedMember = null } = presentation;
      const [editingModels, setEditingModels] = useState(false);
      const setSelectedMember = selectedMember => onPresentation({ selectedMember });
      useEffect(() => { if (nativePart === 'controls' && draft?.showAgents) { setEditingModels(true); onDraft?.({ showAgents: false }); } }, [nativePart, draft?.showAgents]);
      const active = ['planning', 'running', 'discussing'].includes(room.status), notice = roomNotice(room);
      const canStartGoal = ['completed', 'stopped'].includes(room.status);
      if (nativePart === 'controls') return h('div', null,
        h('select', { 'aria-label': 'Message recipient', value: recipient, onChange: e => setRecipient(e.target.value) },
          h('option', { value: 'lead' }, '@lead'), h('option', { value: 'team' }, '@team'),
          room.members.map(member => h('option', { key: member.id, value: member.id }, '@' + member.name))),
        h('button', { type: 'button', disabled: busy || active || room.status === 'pausing', onClick: () => setEditingModels(true), title: 'Select the models for your next plan' }, 'Models'),
        canStartGoal ? h('button', { type: 'button', disabled: busy, 'aria-pressed': newGoal, onClick: () => onDraft?.({ newGoal: !newGoal }) }, 'New goal') : null,
        editingModels ? h(TeamEditor, { room, data, busy, onClose: () => { if (!busy) setEditingModels(false); }, onSave: async values => { if (await command('team', values)) setEditingModels(false); } }) : null);
      return h('section', { className: 'sc-room' },
        showTasks ? h('div', { className: 'sc-inline-board' }, h(Board, { room, busy, command, onOpen: setEvidence })) : null,
        room.nextTeam ? h('div', { className: 'sc-checkpoint' }, h('p', null, 'Your selected models are saved for the next plan.'), h('button', { disabled: busy || active || room.status === 'pausing', onClick: () => command('replan-team') }, 'Replan with selected models')) : null,
        room.status === 'awaiting-approval' ? h('div', { className: 'sc-checkpoint' }, h('p', null, 'The team’s plan is ready. Review the tasks before any edits.'), h('button', { className: 'sc-primary', disabled: busy || !room.tasks.length || !!room.nextTeam, onClick: () => command('approve') }, 'Approve plan')) : null,
        ['paused', 'blocked', 'draft'].includes(room.status) && !(room.status === 'draft' && room.chatOnly) ? h('div', { className: 'sc-checkpoint' }, h('div', null, h('p', { role: 'status' }, room.reason ? notice.text : 'Continue this conversation when you’re ready.'),
          notice.detail ? h('details', null, h('summary', null, 'Technical details'), h('pre', null, notice.detail)) : null),
          h('button', { disabled: busy || !!room.nextTeam, title: notice.action, onClick: () => command(room.status === 'draft' ? 'plan' : 'resume') }, 'Continue')) : null,
        h(Messages, { room, onOpen: setEvidence, onMember: setSelectedMember }),
        selectedMember ? h(MemberCard, { member: selectedMember, room, onClose: () => setSelectedMember(null), onMessage: id => { setRecipient(id); setSelectedMember(null); document.querySelector('[data-composer-card] [contenteditable=true]')?.focus?.(); } }) : null,
        evidence ? h(EvidencePanel, { target: evidence, workspace: room.workspace, onClose: () => setEvidence(null), onOpen: setEvidence }) : null);
    }
    async function apply(ctx) {
      ctx.effect(() => { const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style); return () => style.remove(); });
      try {
        const { createSessionIntegration } = await require.async('./client.sessions.js');
        createSessionIntegration(ctx, { request, Setup, Room, RoomHeader, Icon }).install();
      } catch (error) { console.error('SuperCode session integration could not initialize:', error); throw error; }
    }
    return { apply, inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'layout', 'conversation'], Setup, AgentPicker, AvatarStack, MemberCard, Room, RoomHeader, roomNotice, Board, Messages, PreviousRuns, TaskCard, TaskEditor, MemberForm, EvidenceText, EvidencePanel, RichMessage,
      availableModels, initialMembers, TeamModelSelect, TeamEditor, efforts, evidenceTarget, groupMessages, conversationGroups, request };
  },
});
