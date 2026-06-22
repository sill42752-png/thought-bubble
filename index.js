/*
 * 마음풍선 / Thought Bubble
 * Generates a short Korean inner thought for the latest character message only.
 */

const TB_MODULE_NAME = 'thought_bubble';
const TB_SETTINGS_KEY = `${TB_MODULE_NAME}_settings_v2`;
const TB_ROOT_ID = 'thought_bubble_settings';
const TB_PANEL_CLASS = 'tb-thought-panel';
const TB_ACTION_CLASS = 'tb-thought-action';

const TB_DEFAULT_SETTINGS = {
    enabled: true,
    autoGenerate: true,
    tone: 'subtle',
    maxLength: 2,
    replacePrevious: true,
    connectionProfile: '',
};

let tbSettings = loadSettings();
let tbObserver = null;
let tbIsGenerating = false;
let tbPendingIndex = null;
let tbLastAutoKey = '';

function log(...args) {
    console.log('[Thought Bubble]', ...args);
}

function warn(...args) {
    console.warn('[Thought Bubble]', ...args);
}

function error(...args) {
    console.error('[Thought Bubble]', ...args);
}

function getContextSafe() {
    try {
        return globalThis.SillyTavern?.getContext?.() || null;
    } catch (err) {
        error('Failed to get SillyTavern context:', err);
        return null;
    }
}

function loadSettings() {
    try {
        const raw = localStorage.getItem(TB_SETTINGS_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return { ...TB_DEFAULT_SETTINGS, ...parsed, language: 'ko' };
    } catch (err) {
        warn('Settings were corrupted. Falling back to defaults.', err);
        return { ...TB_DEFAULT_SETTINGS, language: 'ko' };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(TB_SETTINGS_KEY, JSON.stringify(tbSettings));
    } catch (err) {
        error('Failed to save settings:', err);
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function stripHtml(value) {
    const div = document.createElement('div');
    div.innerHTML = String(value ?? '');
    return div.textContent || div.innerText || '';
}

function compactText(value, limit = 2200) {
    return stripHtml(value)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit);
}

function simpleHash(value) {
    const text = String(value ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return String(hash);
}

function isCharacterMessage(message) {
    if (!message) return false;
    if (message.is_user || message.is_system) return false;
    if (!message.mes || !String(message.mes).trim()) return false;
    return true;
}

function getLatestCharacterMessage() {
    const context = getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : [];

    for (let i = chat.length - 1; i >= 0; i--) {
        if (isCharacterMessage(chat[i])) {
            return { index: i, message: chat[i] };
        }
    }

    return null;
}

function getMessageElementByIndex(index) {
    if (index === null || index === undefined) return null;

    const selectors = [
        `#chat .mes[mesid="${index}"]`,
        `#chat .mes[data-mes-id="${index}"]`,
        `#chat .mes[data-message-id="${index}"]`,
    ];

    for (const selector of selectors) {
        const found = document.querySelector(selector);
        if (found) return found;
    }

    const messages = Array.from(document.querySelectorAll('#chat .mes'));
    return messages.find((el) => Number(el.getAttribute('mesid')) === Number(index)) || null;
}

function removePanelsExcept(messageElement) {
    document.querySelectorAll(`.${TB_PANEL_CLASS}`).forEach((node) => {
        if (!messageElement || !messageElement.contains(node)) {
            node.remove();
        }
    });
}

function getExistingPanel(messageElement) {
    return messageElement?.querySelector(`.${TB_PANEL_CLASS}`) || null;
}

function renderPanel(messageElement, state, text = '') {
    if (!messageElement) return null;

    let panel = getExistingPanel(messageElement);
    if (!panel) {
        panel = document.createElement('div');
        panel.className = TB_PANEL_CLASS;
        panel.dataset.thoughtBubbleIgnore = 'true';
        panel.setAttribute('aria-live', 'polite');

        const target = messageElement.querySelector('.mes_text') || messageElement;
        if (target === messageElement) {
            messageElement.appendChild(panel);
        } else {
            target.insertAdjacentElement('afterend', panel);
        }
    }

    panel.dataset.state = state;

    if (state === 'loading') {
        panel.innerHTML = [
            '<div class="tb-thought-title">속마음</div>',
            '<div class="tb-thought-body tb-loading">속마음을 불러오는 중…</div>',
        ].join('');
        return panel;
    }

    if (state === 'error') {
        panel.innerHTML = [
            '<div class="tb-thought-title">속마음</div>',
            `<div class="tb-thought-body tb-error">${escapeHtml(text || '생성에 실패했습니다.')}</div>`,
            '<button type="button" class="tb-thought-action">다시 생성</button>',
        ].join('');
        return panel;
    }

    panel.innerHTML = [
        '<div class="tb-thought-title">속마음</div>',
        `<div class="tb-thought-body">${escapeHtml(text)}</div>`,
        '<button type="button" class="tb-thought-action">다시 생성</button>',
    ].join('');
    return panel;
}

function attachPanelAction(panel, latestIndex) {
    panel?.querySelector(`.${TB_ACTION_CLASS}`)?.addEventListener('click', () => {
        generateForIndex(latestIndex, { force: true });
    });
}

function buildPrompt(latestIndex) {
    const context = getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const latest = chat[latestIndex];
    const previous = chat.slice(Math.max(0, latestIndex - 8), latestIndex)
        .map((message) => {
            const speaker = message.is_user ? 'User' : 'Character';
            return `${speaker}: ${compactText(message.mes, 700)}`;
        })
        .filter(Boolean)
        .join('\n');

    const latestText = compactText(latest?.mes, 1400);
    const characterName = latest?.name || context?.name2 || 'Character';

    const toneMap = {
        subtle: '절제되고 자연스럽게. 감정을 과장하지 말 것',
        romantic: '로맨틱하지만 과장된 멜로드라마처럼 쓰지 말 것',
        tense: '긴장감 있고 갈등이 느껴지되 차분하게',
        playful: '장난스럽고 가볍게, 하지만 캐릭터성을 해치지 않게',
    };

    const toneInstruction = toneMap[tbSettings.tone] || toneMap.subtle;
    const lineLimit = Number(tbSettings.maxLength) || 2;

    const systemPrompt = [
        '너는 롤플레이 캐릭터의 숨은 속마음만 짧게 작성한다.',
        '반드시 한국어로만 작성한다.',
        '장면을 이어 쓰지 말고, 캐릭터의 마음속 독백만 출력한다.',
        '사용자의 행동이나 대사를 대신 쓰지 않는다.',
        '해설, 따옴표, 제목, "속마음:" 같은 라벨을 붙이지 않는다.',
        'AI, 어시스턴트, 프롬프트, 지시문을 언급하지 않는다.',
        '출력은 속마음 본문만 한다.',
    ].join(' ');

    const prompt = [
        `캐릭터 이름: ${characterName}`,
        `톤: ${toneInstruction}.`,
        `길이: 최대 ${lineLimit}문장.`,
        '',
        '최근 대화 맥락:',
        previous || '(이전 대화 없음)',
        '',
        '가장 최근 캐릭터 답변:',
        latestText,
        '',
        '이 순간 캐릭터가 겉으로 말하지 않은 속마음을 한국어로만 작성해.',
    ].join('\n');

    return { systemPrompt, prompt };
}

function getProfileOptionPayload() {
    const profile = String(tbSettings.connectionProfile || '').trim();
    if (!profile) return {};

    return {
        profile,
        profileName: profile,
        connectionProfile: profile,
        connectionProfileName: profile,
    };
}

function normalizeGenerationResult(result) {
    if (typeof result === 'string') return result;
    if (result?.text) return result.text;
    if (result?.content) return result.content;
    if (result?.message) return result.message;
    if (result?.response) return result.response;
    if (Array.isArray(result) && result.length) return normalizeGenerationResult(result[0]);
    return String(result ?? '');
}

async function callGenerator(systemPrompt, prompt) {
    const context = getContextSafe();
    const profilePayload = getProfileOptionPayload();

    if (typeof context?.generateTask === 'function') {
        const taskPayloads = [
            {
                prompt,
                systemPrompt,
                instruct: systemPrompt,
                quiet: true,
                maxResponseLength: 350,
                ...profilePayload,
            },
            {
                task: prompt,
                prompt,
                systemPrompt,
                quiet: true,
                ...profilePayload,
            },
        ];

        for (const payload of taskPayloads) {
            try {
                return normalizeGenerationResult(await context.generateTask(payload));
            } catch (err) {
                warn('generateTask attempt failed, trying fallback:', err);
            }
        }
    }

    if (typeof context?.generateRaw === 'function') {
        const rawPayloads = [
            { systemPrompt, prompt, ...profilePayload },
            { system_prompt: systemPrompt, prompt, ...profilePayload },
        ];

        for (const payload of rawPayloads) {
            try {
                return normalizeGenerationResult(await context.generateRaw(payload));
            } catch (err) {
                warn('generateRaw object attempt failed, trying fallback:', err);
            }
        }

        try {
            return normalizeGenerationResult(await context.generateRaw(prompt));
        } catch (err) {
            warn('generateRaw string attempt failed:', err);
        }
    }

    throw new Error('현재 SillyTavern 환경에서 사용할 수 있는 생성 함수를 찾지 못했습니다.');
}

async function generateThought(latestIndex) {
    const { systemPrompt, prompt } = buildPrompt(latestIndex);
    const result = await callGenerator(systemPrompt, prompt);

    return compactText(result, 500)
        .replace(/^['"“”‘’]+|['"“”‘’]+$/g, '')
        .replace(/^속마음\s*[:：]\s*/i, '')
        .trim();
}

function getMessageKey(index) {
    const context = getContextSafe();
    const message = context?.chat?.[index];
    return `${index}:${simpleHash(message?.mes || '')}`;
}

async function generateForIndex(latestIndex, options = {}) {
    if (!tbSettings.enabled) return;

    const messageElement = getMessageElementByIndex(latestIndex);
    if (!messageElement) return;

    const key = getMessageKey(latestIndex);

    if (!options.force && tbLastAutoKey === key && getExistingPanel(messageElement)) {
        return;
    }

    if (tbIsGenerating) {
        tbPendingIndex = latestIndex;
        return;
    }

    if (tbSettings.replacePrevious) {
        const panel = getExistingPanel(messageElement);
        if (panel) panel.remove();
    }

    tbIsGenerating = true;
    tbLastAutoKey = key;
    const loadingPanel = renderPanel(messageElement, 'loading');
    attachPanelAction(loadingPanel, latestIndex);

    try {
        const thought = await generateThought(latestIndex);
        if (!thought) throw new Error('빈 응답이 돌아왔습니다.');
        const donePanel = renderPanel(messageElement, 'done', thought);
        attachPanelAction(donePanel, latestIndex);
    } catch (err) {
        error('Thought generation failed:', err);
        const errorPanel = renderPanel(messageElement, 'error', err?.message || '생성에 실패했습니다. 콘솔 로그를 확인해 주세요.');
        attachPanelAction(errorPanel, latestIndex);
    } finally {
        tbIsGenerating = false;
        if (tbPendingIndex !== null && tbPendingIndex !== latestIndex) {
            const pending = tbPendingIndex;
            tbPendingIndex = null;
            window.setTimeout(() => generateForIndex(pending), 50);
        } else {
            tbPendingIndex = null;
        }
    }
}

function ensureLatestThought() {
    try {
        if (!tbSettings.enabled) {
            removePanelsExcept(null);
            return;
        }

        const latest = getLatestCharacterMessage();
        if (!latest) {
            removePanelsExcept(null);
            return;
        }

        const messageElement = getMessageElementByIndex(latest.index);
        if (!messageElement) return;

        removePanelsExcept(messageElement);

        const existingPanel = getExistingPanel(messageElement);
        if (existingPanel) {
            attachPanelAction(existingPanel, latest.index);
        }

        if (tbSettings.autoGenerate) {
            window.setTimeout(() => generateForIndex(latest.index), 80);
        }
    } catch (err) {
        error('Failed to attach latest thought:', err);
    }
}

function createSettingsHtml() {
    return `
        <div id="${TB_ROOT_ID}" class="tb-settings" data-thought-bubble-ignore="true">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>마음풍선</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label">
                        <input id="tb_enabled" type="checkbox" ${tbSettings.enabled ? 'checked' : ''}>
                        <span>확장 사용</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="tb_auto_generate" type="checkbox" ${tbSettings.autoGenerate ? 'checked' : ''}>
                        <span>최근 캐릭터 답변에 자동 생성</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="tb_replace_previous" type="checkbox" ${tbSettings.replacePrevious ? 'checked' : ''}>
                        <span>다시 생성할 때 이전 속마음 교체</span>
                    </label>

                    <label for="tb_connection_profile">연결 프로필 이름</label>
                    <input id="tb_connection_profile" type="text" class="text_pole" placeholder="비우면 현재 연결 사용" value="${escapeHtml(tbSettings.connectionProfile || '')}">

                    <label for="tb_tone">속마음 톤</label>
                    <select id="tb_tone">
                        <option value="subtle" ${tbSettings.tone === 'subtle' ? 'selected' : ''}>절제된 톤</option>
                        <option value="romantic" ${tbSettings.tone === 'romantic' ? 'selected' : ''}>로맨틱</option>
                        <option value="tense" ${tbSettings.tone === 'tense' ? 'selected' : ''}>긴장감</option>
                        <option value="playful" ${tbSettings.tone === 'playful' ? 'selected' : ''}>장난스러움</option>
                    </select>

                    <label for="tb_max_length">최대 문장 수</label>
                    <select id="tb_max_length">
                        <option value="1" ${Number(tbSettings.maxLength) === 1 ? 'selected' : ''}>1문장</option>
                        <option value="2" ${Number(tbSettings.maxLength) === 2 ? 'selected' : ''}>2문장</option>
                        <option value="3" ${Number(tbSettings.maxLength) === 3 ? 'selected' : ''}>3문장</option>
                    </select>

                    <div class="tb-note">
                        가장 최근 캐릭터 답변 1개에만 속마음을 자동으로 붙입니다. 속마음은 항상 한국어로 생성됩니다.
                    </div>
                </div>
            </div>
        </div>`;
}

function bindSettingsEvents() {
    const root = document.getElementById(TB_ROOT_ID);
    if (!root) return;

    const bindCheckbox = (id, key) => {
        root.querySelector(`#${id}`)?.addEventListener('change', (event) => {
            tbSettings[key] = Boolean(event.target.checked);
            saveSettings();
            ensureLatestThought();
        });
    };

    const bindValue = (id, key) => {
        root.querySelector(`#${id}`)?.addEventListener('change', (event) => {
            tbSettings[key] = event.target.value;
            saveSettings();
            ensureLatestThought();
        });
    };

    bindCheckbox('tb_enabled', 'enabled');
    bindCheckbox('tb_auto_generate', 'autoGenerate');
    bindCheckbox('tb_replace_previous', 'replacePrevious');
    bindValue('tb_connection_profile', 'connectionProfile');
    bindValue('tb_tone', 'tone');
    bindValue('tb_max_length', 'maxLength');
}

function mountSettings() {
    try {
        if (document.getElementById(TB_ROOT_ID)) return;

        const target = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
        if (!target) {
            warn('Extensions settings container not found. Settings UI was skipped.');
            return;
        }

        target.insertAdjacentHTML('beforeend', createSettingsHtml());
        bindSettingsEvents();
    } catch (err) {
        error('Failed to mount settings:', err);
    }
}

function setupObserver() {
    try {
        if (tbObserver) tbObserver.disconnect();

        const chat = document.querySelector('#chat');
        if (!chat) return;

        tbObserver = new MutationObserver(() => {
            window.requestAnimationFrame(ensureLatestThought);
        });

        tbObserver.observe(chat, { childList: true, subtree: true });
    } catch (err) {
        error('Failed to setup observer:', err);
    }
}

function bindSillyTavernEvents() {
    try {
        const context = getContextSafe();
        const eventSource = context?.eventSource;
        const eventTypes = context?.event_types;
        if (!eventSource || !eventTypes) return;

        const rerender = () => window.setTimeout(ensureLatestThought, 120);

        [
            'CHARACTER_MESSAGE_RENDERED',
            'CHAT_CHANGED',
            'MESSAGE_EDITED',
            'MESSAGE_DELETED',
            'MESSAGE_SWIPED',
            'GENERATION_ENDED',
        ].forEach((name) => {
            if (eventTypes[name]) eventSource.on(eventTypes[name], rerender);
        });
    } catch (err) {
        warn('Failed to bind SillyTavern events. MutationObserver fallback will still run.', err);
    }
}

function initThoughtBubble() {
    try {
        mountSettings();
        setupObserver();
        bindSillyTavernEvents();
        ensureLatestThought();
        log('Loaded.');
    } catch (err) {
        error('Initialization failed:', err);
    }
}

(function bootstrap() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initThoughtBubble, { once: true });
    } else {
        window.setTimeout(initThoughtBubble, 0);
    }
})();
