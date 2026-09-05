import { describe, expect, it } from "vitest";
import {
  MASCOT_BANNER_LINES,
  MASCOT_BANNER_LINES_COMPACT,
  MASCOT_COMPACT_THRESHOLD_COLUMNS,
  MASCOT_THINKING_FRAMES,
  mascotFaceFor,
  mascotThinkingFrame,
  selectMascotBannerLines,
} from "./mascot.js";

describe("mascotThinkingFrame", () => {
  it("cicla pelos frames na ordem, do primeiro ao último", () => {
    for (let tick = 0; tick < MASCOT_THINKING_FRAMES.length; tick++) {
      expect(mascotThinkingFrame(tick)).toBe(MASCOT_THINKING_FRAMES[tick]);
    }
  });

  it("dá a volta (wrap-around) depois do último frame, em vez de undefined ou travar", () => {
    expect(mascotThinkingFrame(MASCOT_THINKING_FRAMES.length)).toBe(MASCOT_THINKING_FRAMES[0]);
    expect(mascotThinkingFrame(MASCOT_THINKING_FRAMES.length + 1)).toBe(MASCOT_THINKING_FRAMES[1]);
  });

  it("continua ciclando corretamente depois de várias voltas completas", () => {
    const manyLaps = MASCOT_THINKING_FRAMES.length * 5 + 2;
    expect(mascotThinkingFrame(manyLaps)).toBe(MASCOT_THINKING_FRAMES[2]);
  });
});

describe("mascotFaceFor", () => {
  it("cada estado (success/error/cancelled) tem uma carinha própria", () => {
    expect(mascotFaceFor("success")).toBe("(^ ^)");
    expect(mascotFaceFor("error")).toBe("(? ?)");
    expect(mascotFaceFor("cancelled")).toBe("(- -)");
  });

  it("as três carinhas são visualmente distintas entre si (nenhuma reaproveitada por engano)", () => {
    const faces = new Set(["success", "error", "cancelled"].map((o) => mascotFaceFor(o as never)));
    expect(faces.size).toBe(3);
  });

  it("todas as carinhas de reação têm a mesma largura da carinha de \"pensando\", pra parecer o mesmo personagem", () => {
    const idleWidth = MASCOT_THINKING_FRAMES[0]!.length;
    for (const outcome of ["success", "error", "cancelled"] as const) {
      expect(mascotFaceFor(outcome)).toHaveLength(idleWidth);
    }
  });
});

describe("MASCOT_BANNER_LINES", () => {
  it("tem uma altura modesta (poucas linhas) e uma largura estreita, pra não quebrar em terminais estreitos", () => {
    expect(MASCOT_BANNER_LINES.length).toBeLessThanOrEqual(8);
    for (const line of MASCOT_BANNER_LINES) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it("é só ASCII puro — sem caracteres largos/multi-byte que possam sair torto em terminais limitados", () => {
    for (const line of MASCOT_BANNER_LINES) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(line)).toBe(true);
    }
  });
});

describe("MASCOT_BANNER_LINES_COMPACT", () => {
  it("é mais estreita e mais baixa que a versão completa, e também só ASCII puro", () => {
    const fullWidth = Math.max(...MASCOT_BANNER_LINES.map((l) => l.length));
    const compactWidth = Math.max(...MASCOT_BANNER_LINES_COMPACT.map((l) => l.length));
    expect(compactWidth).toBeLessThan(fullWidth);
    expect(MASCOT_BANNER_LINES_COMPACT.length).toBeLessThan(MASCOT_BANNER_LINES.length);
    for (const line of MASCOT_BANNER_LINES_COMPACT) {
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(line)).toBe(true);
    }
  });
});

describe("selectMascotBannerLines", () => {
  it("usa a arte completa quando a largura não é conhecida (undefined)", () => {
    expect(selectMascotBannerLines(undefined)).toBe(MASCOT_BANNER_LINES);
  });

  it("usa a arte completa quando o terminal é largo o suficiente", () => {
    expect(selectMascotBannerLines(MASCOT_COMPACT_THRESHOLD_COLUMNS)).toBe(MASCOT_BANNER_LINES);
    expect(selectMascotBannerLines(120)).toBe(MASCOT_BANNER_LINES);
  });

  it("troca pra versão compacta quando o terminal é mais estreito que o limiar", () => {
    expect(selectMascotBannerLines(MASCOT_COMPACT_THRESHOLD_COLUMNS - 1)).toBe(MASCOT_BANNER_LINES_COMPACT);
    expect(selectMascotBannerLines(10)).toBe(MASCOT_BANNER_LINES_COMPACT);
  });
});
