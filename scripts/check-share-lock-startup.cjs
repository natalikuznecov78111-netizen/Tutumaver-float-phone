const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

function load(file, mocks, globals = {}) {
  const box = { exports: {}, require: id => id in mocks ? mocks[id] : id.endsWith('.css') ? {} : require(id), console, ...globals };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, box, { filename: file });
  return box.exports;
}

(async () => {
  let config = { enabled: false, wallpaper: 'saved-wallpaper', pinHash: '', pinLength: 6 };
  let assetReads = 0, imageLoads = 0, finishRead, finishImage, finishDecode;
  class ImageMock {
    set src(url) { imageLoads++; this.url = url; finishImage = () => this.onload(); }
    decode() { return new Promise(resolve => { finishDecode = resolve; }); }
  }
  const { preparePhoneLockForFirstPaint: prepare } = load('lib/phone-lock-startup.ts', {
    './phone-lock': { loadPhoneLock: () => config },
    './chat-asset-storage': { getChatImageFromIndexedDB: () => { assetReads++; return new Promise(resolve => { finishRead = resolve; }); } }
  }, { Image: ImageMock, document: { fonts: { load: async () => [] } } });
  assert.equal((await prepare()).config.enabled, false);
  assert.equal(assetReads, 0);
  assert.equal(imageLoads, 0);
  config = { ...config, enabled: true };
  let settled = false;
  const pending = prepare().then(value => { settled = true; return value; });
  assert.equal(assetReads, 1);
  assert.equal(settled, false);
  finishRead('data:image/png;base64,test');
  await new Promise(setImmediate);
  assert.equal(imageLoads, 1);
  assert.equal(settled, false);
  finishImage();
  await new Promise(setImmediate);
  assert.equal(settled, false);
  finishDecode();
  assert.equal((await pending).wallpaper, 'data:image/png;base64,test');

  // A bad image must release startup with the default background.
  config = { ...config, wallpaper: 'https://example.invalid/broken.png' };
  const broken = load('lib/phone-lock-startup.ts', {
    './phone-lock': { loadPhoneLock: () => config },
    './chat-asset-storage': { getChatImageFromIndexedDB: () => { throw Error('Direct URL must not query IDB'); } }
  }, { Image: class { set src(url) { this.onerror(); } }, console: { warn() {} } });
  assert.equal((await broken.preparePhoneLockForFirstPaint()).wallpaper, '');

  let date = new Date(2026, 10, 15, 13, 37);
  const lock = load('components/phone-lock-screen.tsx', {
    react: { ...React, useState: initial => [initial === null ? date : initial, () => {}], useEffect() {}, useId: () => 'test-clock' },
    '@/lib/phone-lock': { loadPhoneLock: () => config, formatPhoneLockDate: () => '日期', hashPhonePin: async x => x }
  }).PhoneLockScreen;
  let markup = renderToStaticMarkup(lock({ ready: true, wallpaper: 'data:image/png;base64,test', onEnter() {} }));
  assert(markup.includes('data:image/png;base64,test'));
  assert(markup.includes('aria-label="13:37"'));
  assert(!markup.includes('textLength'));
  for (let minutes = 0; minutes < 1440; minutes++) {
    date = new Date(2026, 10, 15, Math.floor(minutes / 60), minutes % 60);
    markup = renderToStaticMarkup(lock({ ready: true, onEnter() {} }));
    const expected = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    assert.equal([...markup.matchAll(/<text\b[^>]*>(.*?)<\/text>/g)].map(m => m[1]).join(''), expected);
  }
  config = { ...config, enabled: false };
  assert.equal(lock({ ready: true, onEnter() {} }), null);
  assert.equal(lock({ ready: false, onEnter() {} }), null);
  const main = fs.readFileSync('components/main-app.tsx', 'utf8');
  assert(main.indexOf('await hydrateKvDb()') < main.indexOf('await preparePhoneLockForFirstPaint()'));
  assert(main.indexOf('await preparePhoneLockForFirstPaint()') < main.indexOf('setHydrated(true)'));
  assert(!main.includes('<PhoneLockScreen'));
  console.log('PASS: disabled lock skips assets/render; startup waits for wallpaper read/load/decode; bad images fall back; custom wallpaper in first markup; all 1,440 clock values retain five characters; hydration precedes lock preparation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
