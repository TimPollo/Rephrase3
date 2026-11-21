'use strict';

const statusLine = document.querySelector('#status');
const result = document.querySelector('#result');
const paste = document.querySelector('#paste');
const photo = document.querySelector('#photo');
const asset = name => new URL(name, document.baseURI).href;

let workerPromise;
let revision = 0;
let scanQueue = Promise.resolve();

function getWorker() {
  workerPromise ??= Tesseract.createWorker('eng', 1, {
    workerPath: asset('worker.min.js'),
    corePath: asset('tesseract-core-lstm.wasm.js'),
    langPath: asset('./'),
    gzip: true,
    workerBlobURL: false,
  }).catch(error => {
    workerPromise = undefined;
    throw error;
  });
  return workerPromise;
}

function rephrase(original) {
  const line = original.replace(/\s+/g, ' ').trim()
    .replace(/\s+(?:to (?:confirm|verify) (?:your account|that you are human)|to continue)[.!:]?$/i, '')
    .replace(/[.!?:]$/, '');
  const tile = '(?:squares?|tiles?|images?|pictures?|photos?)';
  const relation = '(?:contain(?:ing|s)?|show(?:ing|s)?|with|that (?:contain|show)|where you (?:see|can see))';
  const selection = new RegExp('^(?:please )?(?:select|click|tap|choose) all ' + tile + ' ' + relation + ' (.+)$', 'i');
  const question = new RegExp('^which ' + tile + ' ' + relation + ' (.+)$', 'i');
  const capture = line.match(selection) || line.match(question);
  if (!capture) return original;
  const target = capture[1];
  const noun = target.match(/^(?:(a|an) )?([a-z]+(?:[- ][a-z]+){0,3})$/i);
  if (!noun || /\b(?:no|not|without|or|and|except|least|most|only|above|below|next|on|in|under|over|beside|with|the|each|one|two|three|more|than|has|have|is|are)\b/i.test(noun[2])) return original;
  let subject = noun[2];
  if (noun[1]) {
    const words = subject.split(' ');
    const last = words.pop();
    const irregular = { mouse: 'mice', goose: 'geese', ox: 'oxen', wolf: 'wolves',
      calf: 'calves', loaf: 'loaves', person: 'people', man: 'men', woman: 'women',
      child: 'children', deer: 'deer', sheep: 'sheep', fish: 'fish', moose: 'moose',
      aircraft: 'aircraft', bus: 'buses', potato: 'potatoes', tomato: 'tomatoes',
      fox: 'foxes', rhinoceros: 'rhinoceroses' };
    const lower = last.toLowerCase();
    const inflected = Object.prototype.hasOwnProperty.call(irregular, lower) ? irregular[lower]
      : /[^aeiou]y$/i.test(last) ? last.slice(0, -1) + 'ies'
      : /(?:ch|sh|s|x|z)$/i.test(last) ? last + 'es'
      : last + 's';
    words.push(/^[A-Z]/.test(last) ? inflected[0].toUpperCase() + inflected.slice(1) : inflected);
    subject = words.join(' ');
  }
  return 'Select all ' + subject;
}

async function loadImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 1700 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', {alpha: false});
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function recognize(canvas) {
  const worker = await getWorker();
  // Start above the photos, then expand for taller or lower headings.
  for (const fraction of [0.16, 0.30]) {
    const height = Math.round(canvas.height * fraction);
    if (height < 60) continue;
    const headingCanvas = document.createElement('canvas');
    headingCanvas.width = canvas.width;
    headingCanvas.height = height;
    headingCanvas.getContext('2d').drawImage(canvas, 0, 0);
    const {data} = await worker.recognize(headingCanvas);
    const heading = data.text.trim();
    if (data.confidence >= 82 && (rephrase(heading) !== heading ||
      /^(?:please )?(?:select|choose|tap|click) all [a-z -]+[.!]?$/i.test(heading))) return heading;
  }
  const {data} = await worker.recognize(canvas);
  return /[a-z]{2}/i.test(data.text) && data.confidence >= 30 ? data.text.trim() : '';
}

function submit(file) {
  const current = ++revision;
  result.textContent = '';
  statusLine.textContent = 'Bild wird gelesen …';
  scanQueue = scanQueue.then(async () => {
    if (current !== revision) return;
    let canvas;
    try {
      canvas = await loadImage(file);
    } catch {
      if (current === revision) statusLine.textContent = 'Das Bild lässt sich nicht öffnen. Versuche es mit einem Screenshot.';
      return;
    }
    try {
      const original = await recognize(canvas);
      if (current !== revision) return;
      result.textContent = original ? rephrase(original) : '';
      statusLine.textContent = original ? '' : 'Kein lesbarer Text gefunden.';
    } catch (error) {
      console.error(error);
      if (current === revision) statusLine.textContent = 'Texterkennung konnte nicht starten. Lade die Seite neu.';
    } finally {
      canvas.width = canvas.height = 1;
    }
  });
}

photo.addEventListener('change', () => {
  if (photo.files[0]) submit(photo.files[0]);
  photo.value = '';
});

function pasteHint(message) {
  if (!result.textContent && !scanPending()) statusLine.textContent = message;
}

function scanPending() {
  return statusLine.textContent === 'Bild wird gelesen …';
}

paste.addEventListener('click', async () => {
  paste.disabled = true;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(value => value.startsWith('image/'));
      if (type) {
        submit(await item.getType(type));
        return;
      }
    }
    pasteHint('Kein Bild in der Zwischenablage. Nutze „Foto auswählen“.');
  } catch {
    pasteHint('Einsetzen ist hier nicht verfügbar. Nutze „Foto auswählen“.');
  } finally {
    paste.disabled = false;
  }
});

document.addEventListener('paste', event => {
  const image = [...(event.clipboardData?.files ?? [])].find(file => file.type.startsWith('image/'));
  if (image) {
    event.preventDefault();
    submit(image);
  }
});
