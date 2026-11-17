const fs = require('fs'), vm = require('vm'), ts = require('typescript'), assert = require('node:assert/strict');
function moduleAt(path, mocks = {}, globals = {}) {
    const context = { exports: {}, require: id => id in mocks ? mocks[id] : require(id), console, Error, Blob, Response, URL, AbortController, DOMException, setTimeout, clearTimeout, ...globals };
    vm.runInNewContext(ts.transpileModule(fs.readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
    return context.exports;
}
const tick = () => new Promise(setImmediate);

async function checkSpeech() {
    let payload = { base_resp: { status_code: 0 }, data: { audio: '4944330102' } }, body;
    const audioInstances = [];
    let rejection = false;
    class AudioMock {
        constructor() { audioInstances.push(this); }
        setAttribute() {} removeAttribute() {} load() {} pause() {}
        play() { return rejection ? Promise.reject(new DOMException('denied', 'NotAllowedError')) : Promise.resolve(); }
    }
    const mocks = {
        './android-tts': {}, './chat-storage': { loadChatAppSettings: () => ({}) },
        './settings-storage': {},
    };
    const speech = moduleAt('lib/tts-service.ts', mocks, {
        Audio: AudioMock,
        fetch: async (url, init) => {
            if (init?.body) body = JSON.parse(init.body);
            if (url === 'https://audio.example/file.mp3') return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } });
            return Response.json(payload);
        }
    });
    const config = { provider: 'Minimax', apiKey: 'test-key', defaultVoice: 'test-voice', model: 'speech-2.8-turbo' };
    const blob = await speech.synthesizeSpeech('测试', config);
    assert.equal(blob.size, 5); assert.equal(body.output_format, 'hex'); assert.equal(body.voice_setting.voice_id, 'test-voice');
    payload = { base_resp: { status_code: 1008, status_msg: 'balance insufficient' }, data: { audio: '494433' } };
    await assert.rejects(speech.synthesizeSpeech('测试', config), /1008.*balance/);
    for (const audio of ['https:broken', 'not hex', 'abc', '']) {
        payload = { base_resp: { status_code: 0 }, data: { audio } };
        await assert.rejects(speech.synthesizeSpeech('测试', config));
    }
    payload = { base_resp: { status_code: 0 }, data: { audio: 'https://audio.example/file.mp3' } };
    assert.equal((await speech.synthesizeSpeech('测试', config)).size, 3);
    payload = { base_resp: { status_code: 0 }, data: null };
    await assert.rejects(speech.synthesizeSpeech('测试', config), /未返回音频/);

    rejection = true;
    await assert.rejects(speech.playAudioBlobViaMediaElement(blob, undefined, true).promise, /拦截/);
    // Existing non-call consumers retain their previous completion behavior.
    await speech.playAudioBlobViaMediaElement(blob).promise;
    rejection = false;
    let starts = 0;
    let playback = speech.playAudioBlobViaMediaElement(blob, () => starts++, true);
    await tick(); assert.equal(starts, 1);
    let rejected = assert.rejects(playback.promise, /播放失败/);
    audioInstances.at(-1).onerror(); await rejected;
    playback = speech.playAudioBlobViaMediaElement(blob, undefined, true);
    playback.abort(); await playback.promise;
    playback = speech.playAudioBlobViaMediaElement(blob, undefined, true);
    await tick(); audioInstances.at(-1).onended(); await playback.promise;
    const primed = new AudioMock(); let played = false;
    primed.play = () => { played = true; return Promise.resolve(); };
    speech.primeSpeechAudioElement(primed); assert(played, 'prime must run synchronously inside the click');

    // Decode failure in Web Audio must propagate a failed media fallback to the call UI.
    rejection = true;
    const webAudio = moduleAt('lib/tts-service.ts', mocks, {
        Audio: AudioMock,
        window: { addEventListener() {}, AudioContext: class {
            state = 'running'; suspend() {} decodeAudioData() { return Promise.reject(new Error('decode failed')); }
        } }
    });
    await assert.rejects(webAudio.playAudioBlob(blob, undefined, true).promise, /拦截/);
}

function checkShell() {
    const values = new Map(), attributes = new Set(), preferences = new Map();
    let touch = true, probeWidth = 200;
    const root = {
        style: { getPropertyValue: k => values.get(k) || '', setProperty: (k, v) => values.set(k, v), removeProperty: k => values.delete(k) },
        hasAttribute: k => attributes.has(k), setAttribute: k => attributes.add(k), removeAttribute: k => attributes.delete(k),
        toggleAttribute: (k, on) => on ? attributes.add(k) : attributes.delete(k), appendChild() {},
    };
    const window = { innerWidth: 800, innerHeight: 1280, screen: { width: 800, height: 1280 }, matchMedia: () => ({ matches: touch }) };
    const shell = moduleAt('lib/mobile-shell.ts', {}, {
        window, navigator: { maxTouchPoints: 5 }, process: { env: {} },
        localStorage: { getItem: k => preferences.get(k), setItem: (k, v) => preferences.set(k, v), removeItem: k => preferences.delete(k) },
        document: { documentElement: root, createElement: () => ({ style: {}, getBoundingClientRect: () => ({ width: probeWidth }), remove() {} }) },
    });
    shell.initializeShellLayout(); assert(shell.computeShellZoom() > 1); assert(values.has('--shell-zoom'));
    probeWidth = 100; shell.initializeShellLayout(); assert(attributes.has('data-zoom-fallback'));
    shell.writeShellModeOverride('desktop'); assert(!values.has('--shell-zoom')); assert(!attributes.has('data-zoom-fallback'));
    preferences.clear(); touch = false; window.screen = { width: 390, height: 844 }; window.innerWidth = 980;
    shell.initializeShellLayout(); assert(attributes.has('data-force-mobile')); assert.equal(shell.computeShellZoom(), 1);
    shell.writeShellModeOverride('desktop'); assert(!attributes.has('data-force-mobile'));
    shell.writeShellModeOverride('phone'); assert(attributes.has('data-force-mobile'));
    touch = true; window.innerWidth = 390; window.innerHeight = 844;
    shell.initializeShellLayout(); assert(!values.has('--shell-zoom'), 'normal phone must not be scaled');

    // Drag hit-testing must use visual coordinates after zoom, not layout pixels.
    const desktop = fs.readFileSync('components/desktop-shell.tsx', 'utf8');
    const ast = ts.createSourceFile('desktop.tsx', desktop, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && ['getShellZoom', 'getGridGeometry'].includes(node.name?.text)).map(node => node.getText(ast)).join('\n');
    const geometryContext = {
        exports: {}, GRID_ROWS: 6,
        document: { documentElement: { style: { getPropertyValue: () => '2' } } },
        getComputedStyle: () => ({ gridTemplateColumns: '66px 66px 66px 66px', columnGap: '20px', rowGap: '3px', paddingTop: '10px', paddingBottom: '20px' })
    };
    vm.runInNewContext(ts.transpileModule(functions + '\nexports.geometry=getGridGeometry;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, geometryContext);
    const geometry = geometryContext.exports.geometry({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 780, height: 1200 }) });
    assert.equal(geometry.colWidth, 132); assert.equal(geometry.colStep, 172); assert.equal(geometry.originX, 66); assert.equal(geometry.originY, 20);
}

async function checkChatPlayback() {
    const source = fs.readFileSync('components/chat/message-bubble.tsx', 'utf8');
    const start = source.indexOf('function VoiceMessageBubble(');
    const end = source.indexOf('\nfunction ', start + 5);
    const code = source.slice(start, end < 0 ? undefined : end) + '\nexports.Bubble = VoiceMessageBubble;';
    let stateIndex = 0, refIndex = 0, finishSynthesis, synthesisCount = 0, blocked = true;
    const states = [], refs = [], events = [], audioInstances = [];
    const context = {
        exports: {}, require, console, Error,
        useState: initial => {
            const index = stateIndex++;
            if (!(index in states)) states[index] = initial;
            return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
        },
        useRef: initial => refs[refIndex++] ||= { current: initial }, useEffect() {},
        splitBilingualText: () => null,
        synthesizeVoiceForMessage: () => { synthesisCount++; events.push('synthesize'); return new Promise(resolve => { finishSynthesis = resolve; }); },
        primeSpeechAudioElement: audio => { events.push('prime'); audio.src = 'silent'; },
        speechPlaybackError: () => new Error('播放被浏览器拦截，请点击重试'),
        Audio: class {
            constructor() { audioInstances.push(this); }
            pause() {} removeAttribute() {} load() {}
            play() { return blocked ? Promise.reject(new DOMException('blocked', 'NotAllowedError')) : Promise.resolve(); }
        },
    };
    vm.runInNewContext(ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, context);
    let msg = { id: 'm1', role: 'assistant', mediaData: { label: 'hello' } };
    const render = () => { stateIndex = 0; refIndex = 0; return context.exports.Bubble({ msg, characterId: 'c1', onUpdate: next => { msg = next; } }); };
    render().props.onClick();
    assert.equal(events.join(','), 'prime,synthesize');
    const primed = refs[0].current;
    finishSynthesis('data:audio/mpeg;base64,test');
    await tick();
    assert.equal(audioInstances.length, 1, 'the same element must be reused after synthesis');
    assert.equal(primed.src, msg.mediaUrl);
    assert.equal(states[2], false, 'a playback failure is not a synthesis failure');
    assert.match(states[3], /拦截/);
    blocked = false;
    render().props.onClick(); await tick();
    assert.equal(synthesisCount, 1, 'retry of cached audio must not bill another synthesis');
    assert.equal(states[3], null);
}

(async () => {
    checkShell(); await checkSpeech(); await checkChatPlayback();
    for (const name of ['voice', 'video', 'group']) {
        const source = fs.readFileSync(`components/chat/${name}-call-screen.tsx`, 'utf8');
        assert(source.includes('<SpeechFailureNotice'));
        assert(source.includes('reportSpeechFailure(stage, error, () => { void playSubtitle(subtitle); })'));
        assert(source.includes('stage = "playback"'));
    }
    console.log('PASS: phone/tablet/misreported viewport/manual override/old-WebKit fallback; MiniMax business errors, invalid hex, empty audio and URL output; playback rejection, decode fallback, success and cancellation; synchronous Chat unlock and per-line retry wiring.');
})().catch(error => { console.error(error); process.exitCode = 1; });
