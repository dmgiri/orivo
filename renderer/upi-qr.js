'use strict';
(function exposeOrivoUpiQr(root) {
  const QR_VERSION = 3;
  const QR_SIZE = QR_VERSION * 4 + 17;
  const QR_DATA_CODEWORDS = 55;
  const QR_ECC_CODEWORDS = 15;

  function multiply(left, right) {
    let product = 0;
    for (let bit = 7; bit >= 0; bit--) {
      product = (product << 1) ^ ((product >>> 7) * 0x11d);
      product ^= ((right >>> bit) & 1) * left;
    }
    return product;
  }

  function polynomialMultiply(left, right) {
    const result = Array(left.length + right.length - 1).fill(0);
    left.forEach((value, i) => right.forEach((factor, j) => { result[i + j] ^= multiply(value, factor); }));
    return result;
  }

  function codewords(payload) {
    const bytes = Array.from(new TextEncoder().encode(payload));
    if (bytes.length > 53) throw Error('The UPI payment link is too long for its local QR code.');
    const bits = [0, 1, 0, 0];
    for (let i = 7; i >= 0; i--) bits.push((bytes.length >>> i) & 1);
    for (const byte of bytes) for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
    bits.push(...Array(Math.min(4, QR_DATA_CODEWORDS * 8 - bits.length)).fill(0));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
    for (let pad = 0xec; data.length < QR_DATA_CODEWORDS; pad ^= 0xec ^ 0x11) data.push(pad);

    let generator = [1];
    let rootPower = 1;
    for (let i = 0; i < QR_ECC_CODEWORDS; i++) {
      generator = polynomialMultiply(generator, [1, rootPower]);
      rootPower = multiply(rootPower, 2);
    }
    const remainder = [...data, ...Array(QR_ECC_CODEWORDS).fill(0)];
    for (let i = 0; i < data.length; i++) {
      const factor = remainder[i];
      if (factor) for (let j = 0; j < generator.length; j++) remainder[i + j] ^= multiply(generator[j], factor);
    }
    return [...data, ...remainder.slice(data.length)];
  }

  function matrixFor(payload) {
    const modules = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
    const reserved = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(false));
    const setFunction = (x, y, dark) => {
      if (x >= 0 && x < QR_SIZE && y >= 0 && y < QR_SIZE) {
        modules[y][x] = dark;
        reserved[y][x] = true;
      }
    };
    const finder = (centerX, centerY) => {
      for (let dy = -1; dy <= 7; dy++) for (let dx = -1; dx <= 7; dx++) {
        const distance = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFunction(centerX + dx, centerY + dy, dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && distance !== 2);
      }
    };
    finder(0, 0);
    finder(QR_SIZE - 7, 0);
    finder(0, QR_SIZE - 7);
    for (let i = 8; i < QR_SIZE - 8; i++) {
      setFunction(6, i, i % 2 === 0);
      setFunction(i, 6, i % 2 === 0);
    }
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      setFunction(QR_SIZE - 7 + dx, QR_SIZE - 7 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    const format = value => {
      for (let i = 0; i <= 5; i++) setFunction(8, i, ((value >>> i) & 1) !== 0);
      setFunction(8, 7, ((value >>> 6) & 1) !== 0);
      setFunction(8, 8, ((value >>> 7) & 1) !== 0);
      setFunction(7, 8, ((value >>> 8) & 1) !== 0);
      for (let i = 9; i < 15; i++) setFunction(14 - i, 8, ((value >>> i) & 1) !== 0);
      for (let i = 0; i < 8; i++) setFunction(QR_SIZE - 1 - i, 8, ((value >>> i) & 1) !== 0);
      for (let i = 8; i < 15; i++) setFunction(8, QR_SIZE - 15 + i, ((value >>> i) & 1) !== 0);
      setFunction(8, QR_SIZE - 8, true);
    };
    format(0);

    const data = codewords(payload);
    let bitIndex = 0;
    for (let right = QR_SIZE - 1; right >= 1; right -= 2) {
      if (right === 6) right--;
      for (let vertical = 0; vertical < QR_SIZE; vertical++) {
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? QR_SIZE - 1 - vertical : vertical;
        for (let offset = 0; offset < 2; offset++) {
          const x = right - offset;
          if (reserved[y][x]) continue;
          const byte = data[Math.floor(bitIndex / 8)] || 0;
          const bit = ((byte >>> (7 - (bitIndex & 7))) & 1) !== 0;
          modules[y][x] = bit !== ((x + y) % 2 === 0);
          bitIndex++;
        }
      }
    }
    const formatData = 1 << 3;
    let remainder = formatData << 10;
    while (remainder >= (1 << 10)) {
      const shift = Math.floor(Math.log2(remainder)) - 10;
      remainder ^= 0x537 << shift;
    }
    format(((formatData << 10) | remainder) ^ 0x5412);
    return modules;
  }

  function render(payload) {
    const quietZone = 4;
    const extent = QR_SIZE + quietZone * 2;
    const matrix = matrixFor(payload);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${extent} ${extent}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Scan to pay the Orivo maintainer by UPI');
    svg.setAttribute('shape-rendering', 'crispEdges');
    const background = document.createElementNS(svg.namespaceURI, 'rect');
    background.setAttribute('width', String(extent));
    background.setAttribute('height', String(extent));
    background.setAttribute('fill', '#fff');
    svg.append(background);
    const path = document.createElementNS(svg.namespaceURI, 'path');
    let commands = '';
    for (let y = 0; y < QR_SIZE; y++) for (let x = 0; x < QR_SIZE; x++) {
      if (matrix[y][x]) commands += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
    }
    path.setAttribute('d', commands);
    path.setAttribute('fill', '#111');
    svg.append(path);
    return svg;
  }

  root.OrivoUpiQr = Object.freeze({ matrixFor, render });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.OrivoUpiQr;
})(globalThis);
