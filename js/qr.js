/*
 * Minimal QR code encoder (byte mode, error correction level M, versions 1–10).
 * No dependencies, so the share screen works offline. Output is an SVG string.
 */
(function () {
  'use strict';

  /* ---------- Galois field GF(256) for Reed-Solomon ---------- */

  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initTables() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (!a || !b) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** Generator polynomial of the given degree. */
  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, degree) {
    const gen = rsGenerator(degree);
    const result = new Array(degree).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < degree; i++) result[i] ^= gfMul(gen[i + 1], factor);
    }
    return result;
  }

  /* ---------- Version tables (EC level M) ---------- */

  // [total codewords, ec codewords per block, blocks in group 1, data cw per block (g1), blocks in group 2, data cw per block (g2)]
  const VERSIONS = {
    1: [26, 10, 1, 16, 0, 0],
    2: [44, 16, 1, 28, 0, 0],
    3: [70, 26, 1, 44, 0, 0],
    4: [100, 18, 2, 32, 0, 0],
    5: [134, 24, 2, 43, 0, 0],
    6: [172, 16, 4, 27, 0, 0],
    7: [196, 18, 4, 31, 0, 0],
    8: [242, 22, 2, 38, 2, 39],
    9: [292, 22, 3, 36, 2, 37],
    10: [346, 26, 4, 43, 1, 44],
  };
  const ALIGNMENT = { 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  function dataCapacity(version) {
    const [, , g1, d1, g2, d2] = VERSIONS[version];
    return g1 * d1 + g2 * d2;
  }

  /* ---------- Data encoding ---------- */

  function utf8Bytes(text) {
    return Array.from(new TextEncoder().encode(text));
  }

  function buildCodewords(bytes, version) {
    const capacity = dataCapacity(version);
    const bits = [];
    const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1); };
    push(0b0100, 4);                       // byte mode
    push(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => push(b, 8));
    push(0, Math.min(4, capacity * 8 - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < capacity; pad ^= 0xec ^ 0x11) data.push(pad);

    // Split into blocks, add error correction, then interleave.
    const [, ecLen, g1, d1, g2, d2] = VERSIONS[version];
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < g1; i++) { blocks.push(data.slice(offset, offset + d1)); offset += d1; }
    for (let i = 0; i < g2; i++) { blocks.push(data.slice(offset, offset + d2)); offset += d2; }
    const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));
    const out = [];
    const maxLen = Math.max(d1, d2);
    for (let i = 0; i < maxLen; i++) blocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) ecBlocks.forEach((b) => out.push(b[i]));
    return out;
  }

  /* ---------- Matrix ---------- */

  function makeMatrix(version, codewords) {
    const size = version * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(null)); // null = free for data
    const set = (r, c, v) => { modules[r][c] = v; };

    const finder = (r, c) => {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr; const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark = inner && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(rr, cc, dark ? 1 : 0);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    // Timing patterns
    for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0 ? 1 : 0); set(i, 6, i % 2 === 0 ? 1 : 0); }

    // Alignment patterns
    const centers = ALIGNMENT[version] || [];
    const last = centers[centers.length - 1];
    centers.forEach((r) => centers.forEach((c) => {
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6);
      if (onFinder) return;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0);
      }
    }));

    // Version information (versions 7+), with its BCH remainder
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) & 1 ? 0x1f25 : 0);
      const info = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = (info >> i) & 1;
        set(Math.floor(i / 3), size - 11 + (i % 3), bit);
        set(size - 11 + (i % 3), Math.floor(i / 3), bit);
      }
    }

    // Reserve format areas (filled later) and the dark module
    for (let i = 0; i < 9; i++) { if (modules[8][i] === null) set(8, i, 0); if (modules[i][8] === null) set(i, 8, 0); }
    for (let i = size - 8; i < size; i++) { set(8, i, 0); set(i, 8, 0); }
    set(size - 8, 8, 1);

    // Place data bits in the zigzag order
    const bits = [];
    codewords.forEach((cw) => { for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1); });
    let bitIndex = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let i = 0; i < size; i++) {
        const row = upward ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (modules[row][c] === null) {
            modules[row][c] = bitIndex < bits.length ? bits[bitIndex] : 0;
            modules[row][c] = { data: modules[row][c] }; // mark as data module
            bitIndex++;
          }
        }
      }
      upward = !upward;
    }
    return modules;
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function applyMask(modules, mask) {
    const size = modules.length;
    const grid = modules.map((row) => row.map((m) => (typeof m === 'object' && m !== null ? m.data : m)));
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      const m = modules[r][c];
      if (typeof m === 'object' && m !== null && MASKS[mask](r, c)) grid[r][c] ^= 1;
    }
    // Format information (EC level M = 00) with BCH error correction
    let format = (0b00 << 3) | mask;
    let rem = format;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
    format = ((format << 10) | rem) ^ 0x5412;
    const fbit = (i) => (format >> i) & 1;
    for (let i = 0; i < 6; i++) grid[8][i] = fbit(14 - i);
    grid[8][7] = fbit(8); grid[8][8] = fbit(7); grid[7][8] = fbit(6);
    for (let i = 0; i < 6; i++) grid[5 - i][8] = fbit(i);
    for (let i = 0; i < 8; i++) grid[size - 1 - i][8] = fbit(14 - i);
    for (let i = 0; i < 8; i++) grid[8][size - 8 + i] = fbit(7 - i);
    return grid;
  }

  /** Penalty score (lower is better), simplified to the two most important rules. */
  function penalty(grid) {
    const size = grid.length;
    let score = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (grid[r][c] === grid[r][c - 1]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (grid[r][c] === grid[r - 1][c]) { run++; if (run === 5) score += 3; else if (run > 5) score++; }
        else run = 1;
      }
    }
    for (let r = 0; r < size - 1; r++) for (let c = 0; c < size - 1; c++) {
      const v = grid[r][c];
      if (v === grid[r][c + 1] && v === grid[r + 1][c] && v === grid[r + 1][c + 1]) score += 3;
    }
    return score;
  }

  /** Returns the module grid (array of rows of 0/1) for the text, or null if too long. */
  function encode(text) {
    const bytes = utf8Bytes(text);
    let version = null;
    for (let v = 1; v <= 10; v++) {
      const headerBits = 4 + (v < 10 ? 8 : 16);
      if (bytes.length * 8 + headerBits <= dataCapacity(v) * 8) { version = v; break; }
    }
    if (!version) return null;
    const modules = makeMatrix(version, buildCodewords(bytes, version));
    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const grid = applyMask(modules, mask);
      const score = penalty(grid);
      if (score < bestScore) { bestScore = score; best = grid; }
    }
    return best;
  }

  /** SVG markup for the text; `color` is any CSS color. */
  function toSVG(text, color) {
    const grid = encode(text);
    if (!grid) return '';
    const size = grid.length;
    const quiet = 4;
    let path = '';
    grid.forEach((row, r) => row.forEach((v, c) => { if (v) path += `M${c + quiet} ${r + quiet}h1v1h-1z`; }));
    const total = size + quiet * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="Cod QR">
      <rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="${color || '#000000'}"/></svg>`;
  }

  window.LunaQR = { encode, toSVG };
})();
