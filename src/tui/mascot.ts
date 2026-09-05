// Arte e lógica de seleção de frame do mascote (pinguim) da TUI — pura, sem
// Ink/React, pra poder testar "qual frame pra qual estado" sem precisar
// renderizar nada (ver Mascot.tsx pros componentes Ink que consomem isto).
// Só ASCII puro de propósito (sem caracteres Unicode largos/exóticos) — o
// pedido explícito foi não quebrar em terminais estreitos, e ASCII simples
// é o que tem menos chance de sair torto em qualquer terminal.

// ~13 caracteres de largura, 5 linhas — cabe folgado mesmo num terminal de
// 40 colunas. Corpo/olhos em cor padrão; bico e pés (índices 2 e 4) ganham
// destaque amarelo em MascotBanner (Mascot.tsx) — decisão só visual, sem
// lógica pra testar, por isso fica hardcoded no componente, não aqui.
export const MASCOT_BANNER_LINES: readonly string[] = ["   ___", "  /o o\\", " (  >  )", "  \\___/", "  d   b"];

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
