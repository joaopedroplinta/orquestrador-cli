import { render } from "ink";
import App from "./App.js";

export interface StartTuiOptions {
  /** Seed de ModeState.mascotEnabled — vem da flag --no-mascot do CLI. Padrão true. */
  mascotEnabled?: boolean;
}

export async function startTui(options: StartTuiOptions = {}): Promise<void> {
  // Redesenha só as linhas que mudaram em vez da árvore inteira a cada tecla —
  // reduz bastante o volume de bytes escritos no terminal por frame.
  const { waitUntilExit } = render(<App initialMascotEnabled={options.mascotEnabled} />, {
    incrementalRendering: true,
  });
  await waitUntilExit();
}
