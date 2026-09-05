// Arte e lógica de seleção de frame do mascote (pinguim) da TUI — pura, sem
// Ink/React, pra poder testar "qual frame pra qual estado" sem precisar
// renderizar nada (ver Mascot.tsx pros componentes Ink que consomem isto).
// Só ASCII puro de propósito (sem caracteres Unicode largos/exóticos) — o
// pedido explícito foi não quebrar em terminais estreitos, e ASCII simples
// é o que tem menos chance de sair torto em qualquer terminal.

// ~13 caracteres de largura, 7 linhas — cabe folgado mesmo num terminal de
// 40 colunas. Cor (branco/cinza pro corpo) fica hardcoded em MascotBanner
// (Mascot.tsx) — decisão só visual, sem lógica pra testar, por isso não
// mora aqui.
export const MASCOT_BANNER_LINES: readonly string[] = [
  "      .--.",
  "     |o_o |",
  "     |:_/ |",
  "    //   \\ \\",
  "   (|     | )",
  "  /'\\_   _/`\\",
  "  \\___)=(___/",
];

// Versão compacta pra terminal muito estreito — mesma "cara" (cabeça +
// olhos + bico), sem corpo/pés, pra caber mesmo numa largura mínima.
export const MASCOT_BANNER_LINES_COMPACT: readonly string[] = [" .--.", "|o_o|", "'--'"];

// Abaixo desse número de colunas, `selectMascotBannerLines` troca pra
// versão compacta. Validado com PTY real (ver CLAUDE.md): a arte completa
// (13 colunas de conteúdo + borda/padding da caixa do banner) já não sobra
// margem confortável perto disso — a versão compacta (5 colunas) segura
// terminais bem mais estreitos sem quebrar linha dentro da caixa.
export const MASCOT_COMPACT_THRESHOLD_COLUMNS = 30;

// `columns` é `process.stdout.columns` — `undefined` quando não dá pra
// medir (ex.: stdout não é um TTY de verdade), caso em que assume a arte
// completa (mesmo comportamento de antes dessa função existir).
export function selectMascotBannerLines(columns: number | undefined): readonly string[] {
  if (columns !== undefined && columns < MASCOT_COMPACT_THRESHOLD_COLUMNS) {
    return MASCOT_BANNER_LINES_COMPACT;
  }
  return MASCOT_BANNER_LINES;
}

// Animação "pensando" — mostrada no lugar do spinner padrão enquanto uma
// etapa roda. 4 frames, ciclando enquanto a tarefa não termina.
export const MASCOT_THINKING_FRAMES: readonly string[] = ["(o o)", "(o o).", "(o o)..", "(o o)..."];

// `tick` é só um contador crescente (0, 1, 2, ...) — o módulo faz ele
// ciclar pelos frames disponíveis indefinidamente.
export function mascotThinkingFrame(tick: number): string {
  return MASCOT_THINKING_FRAMES[tick % MASCOT_THINKING_FRAMES.length]!;
}

export type MascotOutcome = "success" | "error" | "cancelled";

// Mesma "família" visual do frame de pensando ((o o)) — só troca o par do
// meio, mantendo largura e formato idênticos, pra parecer o mesmo
// personagem reagindo, não um desenho diferente por estado.
const MASCOT_FACES: Record<MascotOutcome, string> = {
  success: "(^ ^)",
  error: "(? ?)",
  cancelled: "(- -)",
};

export function mascotFaceFor(outcome: MascotOutcome): string {
  return MASCOT_FACES[outcome];
}
