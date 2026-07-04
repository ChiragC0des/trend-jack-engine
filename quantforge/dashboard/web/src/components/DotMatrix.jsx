/**
 * 5x7 dot-matrix numeral renderer (canvas). Data-driven from real numbers
 * passed in by the caller — this component only knows how to draw digits.
 */

import { useEffect, useRef } from "react";

// 5x7 glyphs, rows top->bottom, 5-bit masks (MSB = leftmost column).
const GLYPHS = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "+": [0x00, 0x04, 0x04, 0x1f, 0x04, 0x04, 0x00],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  ".": [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c],
  "$": [0x04, 0x0f, 0x14, 0x0e, 0x05, 0x1e, 0x04],
  "%": [0x18, 0x19, 0x02, 0x04, 0x08, 0x13, 0x03],
  " ": [0, 0, 0, 0, 0, 0, 0],
};

export default function DotMatrix({ text, color = "#4fae7c", dot = 3, gap = 1, dimColor = "rgba(255,255,255,0.05)" }) {
  const ref = useRef(null);
  const cell = dot + gap;
  const charW = 5 * cell + 2 * cell; // 5 cols + 2 col spacing
  const width = text.length * charW;
  const height = 7 * cell;

  useEffect(() => {
    const canvas = ref.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    [...text].forEach((ch, i) => {
      const glyph = GLYPHS[ch] ?? GLYPHS[" "];
      const x0 = i * charW;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          const on = (glyph[row] >> (4 - col)) & 1;
          ctx.fillStyle = on ? color : dimColor;
          ctx.beginPath();
          ctx.arc(x0 + col * cell + dot / 2, row * cell + dot / 2, dot / 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
  }, [text, color, width, height, cell, charW, dot, dimColor]);

  return <canvas ref={ref} style={{ width, height }} aria-label={text} />;
}
