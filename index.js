/*
 * 마음풍선 / Thought Bubble
 * Adds Korean inner-thought bubbles to character messages.
 */

const TB_MODULE_NAME = 'thought_bubble';
const TB_SETTINGS_KEY = `${TB_MODULE_NAME}_settings_v3`;
const TB_ROOT_ID = 'thought_bubble_settings';
const TB_PANEL_CLASS = 'tb-thought-panel';
const TB_ACTION_CLASS = 'tb-thought-action';
const TB_REGEN_CLASS = 'tb-thought-regen';
const TB_MESSAGE_ATTR = 'data-thought-bubble-message-key';

const TB_DEFAULT_SETTINGS = {
    enabled: true,
    autoGenerate: true,
    generateAllMessages: true,
    tone: 'subtle',
    maxLength: 5,
    connectionProfile: '',
    customPrompt: '',
};

let tbSettings = loadSettings();
let tbObserver = null;
let tbQueue = [];
let tbQueuedKeys = new Set();
let tbGenerating = false;
let tbScanTimer = null;

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

function compactText(value, limit = 2600) {
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

function getCharacterMessageEntries() {
    const context = getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    return chat
        .map((message, index) => ({ index, message }))
        .filter(({ message }) => isCharacterMessage(message));
}

function getLatestCharacterMessage() {
    const entries = getCharacterMessageEntries();
    return entries.length ? entries[entries.length - 1] : null;
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

function getExistingPanel(messageElement) {
    return messageElement?.querySelector(`.${TB_PANEL_CLASS}`) || null;
}

function getMessageKey(index) {
    const context = getContextSafe();
    const message = context?.chat?.[index];
    return `${index}:${simpleHash(message?.mes || '')}`;
}

function isPanelCurrent(messageElement, index) {
    const panel = getExistingPanel(messageElement);
    return Boolean(panel && panel.getAttribute(TB_MESSAGE_ATTR) === getMessageKey(index) && ['done', 'loading'].includes(panel.dataset.state));
}

function renderPanel(messageElement, index, state, text = '') {
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
    panel.setAttribute(TB_MESSAGE_ATTR, getMessageKey(index));

    if (state === 'loading') {
        panel.innerHTML = [
            '<div class="tb-thought-title">속마음</div>',
            '<div class="tb-thought-body tb-loading">속마음을 불러오는 중…</div>',
        ].join('');
        attachHeaderAction(messageElement, index);
        return panel;
    }

    if (state === 'error') {
        panel.innerHTML = [
            '<div class="tb-thought-title">속마음</div>',
            `<div class="tb-thought-body tb-error">${escapeHtml(text || '생성에 실패했습니다.')}</div>`,
            '<button type="button" class="tb-thought-action">다시 생성</button>',
        ].join('');
        attachHeaderAction(messageElement, index);
        attachPanelAction(panel, index);
        return panel;
    }

    panel.innerHTML = [
        '<div class="tb-thought-title">속마음</div>',
        `<div class="tb-thought-body">${escapeHtml(text)}</div>`,
        '<button type="button" class="tb-thought-action">다시 생성</button>',
    ].join('');
    attachHeaderAction(messageElement, index);
    attachPanelAction(panel, index);
    return panel;
}

function getMessageNameElement(messageElement) {
    if (!messageElement) return null;

    const selectors = [
        '.name_text',
        '.mes_name',
        '.ch_name .name',
        '.ch_name',
        '.mes_timer',
    ];

    for (const selector of selectors) {
        const found = messageElement.querySelector(selector);
        if (found) return found;
    }

    return null;
}

function attachHeaderAction(messageElement, messageIndex) {
    if (!messageElement) return;

    let button = messageElement.querySelector(`.${TB_REGEN_CLASS}`);
    const nameElement = getMessageNameElement(messageElement);

    if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = TB_REGEN_CLASS;
        button.dataset.thoughtBubbleIgnore = 'true';
        button.title = '속마음 다시 생성';
        button.setAttribute('aria-label', '속마음 다시 생성');
        button.textContent = '💭';
    }

    button.dataset.messageIndex = String(messageIndex);

    if (nameElement && button.parentElement !== nameElement.parentElement) {
        nameElement.insertAdjacentElement('afterend', button);
    } else if (!nameElement && button.parentElement !== messageElement) {
        messageElement.insertAdjacentElement('afterbegin', button);
    }

    if (button.dataset.bound !== 'true') {
        button.dataset.bound = 'true';
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const index = Number(button.dataset.messageIndex);
            if (Number.isFinite(index)) enqueueGeneration(index, { force: true, front: true });
        });
    }
}

function attachPanelAction(panel, messageIndex) {
    const messageElement = panel?.closest?.('.mes');
    attachHeaderAction(messageElement, messageIndex);

    const button = panel?.querySelector?.(`.${TB_ACTION_CLASS}`);
    if (!button || button.dataset.bound === 'true') return;

    button.dataset.bound = 'true';
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        enqueueGeneration(messageIndex, { force: true, front: true });
    });
}

function getToneInstruction() {
    const toneMap = {
        subtle: '절제되고 자연스럽게. 감정을 과장하지 말 것',
        romantic: '로맨틱하지만 과장된 멜로드라마처럼 쓰지 말 것',
        tense: '긴장감 있고 갈등이 느껴지되 차분하게',
        playful: '장난스럽고 가볍게, 하지만 캐릭터성을 해치지 않게',
        hype: '개호들갑스럽게. 감정 리액션이 크고 웃기게, 하지만 장면을 깨는 메타 농담은 하지 말 것',
        chatty: '수다쟁이처럼. 생각이 꼬리에 꼬리를 물고 이어지게, 하지만 캐릭터의 내면 독백으로만 쓸 것',
    };
    return toneMap[tbSettings.tone] || toneMap.subtle;
}

function getLineLimit() {
    const value = Number(tbSettings.maxLength);
    if (!Number.isFinite(value)) return 5;
    return Math.min(10, Math.max(1, Math.round(value)));
}

function buildPrompt(messageIndex) {
    const context = getContextSafe();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const current = chat[messageIndex];
    const previous = chat.slice(Math.max(0, messageIndex - 8), messageIndex)
        .map((message) => {
            const speaker = message.is_user ? 'User' : 'Character';
            return `${speaker}: ${compactText(message.mes, 700)}`;
        })
        .filter(Boolean)
        .join('\n');

    const currentText = compactText(current?.mes, 1600);
    const characterName = current?.name || context?.name2 || 'Character';
    const lineLimit = getLineLimit();

    const systemPrompt = [
        '너는 롤플레이 캐릭터의 숨은 속마음만 작성한다.',
        '반드시 한국어로만 작성한다.',
        '장면을 이어 쓰지 말고 캐릭터의 마음속 독백만 출력한다.',
        '사용자의 행동이나 대사를 대신 쓰지 않는다.',
        '해설, 따옴표, 제목, 번호, 불릿, "속마음:" 같은 라벨을 붙이지 않는다.',
        'AI, 어시스턴트, 프롬프트, 지시문을 언급하지 않는다.',
        '출력은 속마음 본문만 한다.',
        String(tbSettings.customPrompt || '').trim() ? `추가 사용자 지시: ${String(tbSettings.customPrompt).trim()}` : '',
    ].filter(Boolean).join(' ');

    const prompt = [
        `캐릭터 이름: ${characterName}`,
        `톤: ${getToneInstruction()}.`,
        `길이: 최대 ${lineLimit}문장.`,
        '',
        '최근 대화 맥락:',
        previous || '(이전 대화 없음)',
        '',
        '속마음을 만들 캐릭터 답변:',
        currentText,
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
                maxResponseLength: 900,
                ...profilePayload,
            },
            {
                task: prompt,
                prompt,
                systemPrompt,
                quiet: true,
                maxResponseLength: 900,
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

async function generateThought(messageIndex) {
    const { systemPrompt, prompt } = buildPrompt(messageIndex);
    const result = await callGenerator(systemPrompt, prompt);

    return compactText(result, 1200)
        .replace(/^['"“”‘’]+|['"“”‘’]+$/g, '')
        .replace(/^속마음\s*[:：]\s*/i, '')
        .trim();
}

function enqueueGeneration(messageIndex, options = {}) {
    if (!tbSettings.enabled || messageIndex === null || messageIndex === undefined) return;

    const messageElement = getMessageElementByIndex(messageIndex);
    if (!messageElement) return;

    if (!options.force && isPanelCurrent(messageElement, messageIndex)) {
        attachPanelAction(getExistingPanel(messageElement), messageIndex);
        return;
    }

    const queueKey = `${messageIndex}:${options.force ? 'force' : getMessageKey(messageIndex)}`;
    if (tbQueuedKeys.has(queueKey)) return;

    const job = { index: messageIndex, force: Boolean(options.force), queueKey };
    if (options.front) {
        tbQueue.unshift(job);
    } else {
        tbQueue.push(job);
    }
    tbQueuedKeys.add(queueKey);
    processQueue();
}

async function processQueue() {
    if (tbGenerating) return;
    tbGenerating = true;

    while (tbQueue.length) {
        const job = tbQueue.shift();
        tbQueuedKeys.delete(job.queueKey);

        const messageElement = getMessageElementByIndex(job.index);
        if (!messageElement || !tbSettings.enabled) continue;

        if (!job.force && isPanelCurrent(messageElement, job.index)) {
            attachPanelAction(getExistingPanel(messageElement), job.index);
            continue;
        }

        renderPanel(messageElement, job.index, 'loading');

        try {
            const thought = await generateThought(job.index);
            if (!thought) throw new Error('빈 응답이 돌아왔습니다.');
            renderPanel(messageElement, job.index, 'done', thought);
        } catch (err) {
            error('Thought generation failed:', err);
            renderPanel(messageElement, job.index, 'error', err?.message || '생성에 실패했습니다. 콘솔 로그를 확인해 주세요.');
        }
    }

    tbGenerating = false;
}

function removeAllPanels() {
    document.querySelectorAll(`.${TB_PANEL_CLASS}`).forEach((node) => node.remove());
    document.querySelectorAll(`.${TB_REGEN_CLASS}`).forEach((node) => node.remove());
}

function scheduleScan(delay = 120) {
    window.clearTimeout(tbScanTimer);
    tbScanTimer = window.setTimeout(scanMessages, delay);
}

function scanMessages() {
    try {
        if (!tbSettings.enabled) {
            removeAllPanels();
            return;
        }

        const entries = tbSettings.generateAllMessages
            ? getCharacterMessageEntries()
            : [getLatestCharacterMessage()].filter(Boolean);

        for (const { index } of entries) {
            const messageElement = getMessageElementByIndex(index);
            if (!messageElement) continue;

            attachHeaderAction(messageElement, index);

            const panel = getExistingPanel(messageElement);
            if (panel) attachPanelAction(panel, index);

            if (tbSettings.autoGenerate) {
                enqueueGeneration(index);
            }
        }
    } catch (err) {
        error('Failed to scan messages:', err);
    }
}

function createSentenceOptions() {
    let html = '';
    for (let i = 1; i <= 10; i++) {
        html += `<option value="${i}" ${Number(tbSettings.maxLength) === i ? 'selected' : ''}>${i}문장</option>`;
    }
    return html;
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
                        <span>속마음 자동 생성</span>
                    </label>

                    <label class="checkbox_label">
                        <input id="tb_generate_all" type="checkbox" ${tbSettings.generateAllMessages ? 'checked' : ''}>
                        <span>모든 캐릭터 답변에 붙이기</span>
                    </label>

                    <label for="tb_connection_profile">연결 프로필 이름</label>
                    <input id="tb_connection_profile" type="text" class="text_pole" placeholder="비우면 현재 연결 사용" value="${escapeHtml(tbSettings.connectionProfile || '')}">

                    <label for="tb_custom_prompt">속마음 보정 프롬프트</label>
                    <textarea id="tb_custom_prompt" class="text_pole tb-prompt-box" rows="5" placeholder="예: 캐릭터 말투를 더 건조하게, 질투심은 은근하게, 현대어 메타 표현은 피하기">${escapeHtml(tbSettings.customPrompt || '')}</textarea>

                    <label for="tb_tone">속마음 톤</label>
                    <select id="tb_tone">
                        <option value="subtle" ${tbSettings.tone === 'subtle' ? 'selected' : ''}>절제된 톤</option>
                        <option value="romantic" ${tbSettings.tone === 'romantic' ? 'selected' : ''}>로맨틱</option>
                        <option value="tense" ${tbSettings.tone === 'tense' ? 'selected' : ''}>긴장감</option>
                        <option value="playful" ${tbSettings.tone === 'playful' ? 'selected' : ''}>장난스러움</option>
                        <option value="hype" ${tbSettings.tone === 'hype' ? 'selected' : ''}>개호들갑</option>
                        <option value="chatty" ${tbSettings.tone === 'chatty' ? 'selected' : ''}>수다쟁이</option>
                    </select>

                    <label for="tb_max_length">최대 문장 수</label>
                    <select id="tb_max_length">
                        ${createSentenceOptions()}
                    </select>

                    <div class="tb-note">
                        캐릭터 답변마다 한국어 속마음을 생성합니다. 이전 채팅도 화면에 로드되어 있으면 자동으로 붙습니다.
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
            if (!tbSettings.enabled) removeAllPanels();
            scheduleScan(50);
        });
    };

    const bindValue = (id, key) => {
        root.querySelector(`#${id}`)?.addEventListener('change', (event) => {
            tbSettings[key] = event.target.value;
            saveSettings();
            scheduleScan(50);
        });
    };

    bindCheckbox('tb_enabled', 'enabled');
    bindCheckbox('tb_auto_generate', 'autoGenerate');
    bindCheckbox('tb_generate_all', 'generateAllMessages');
    bindValue('tb_connection_profile', 'connectionProfile');
    bindValue('tb_custom_prompt', 'customPrompt');
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
            window.requestAnimationFrame(() => scheduleScan(80));
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

        const rerender = () => scheduleScan(120);

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
        scheduleScan(300);
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
