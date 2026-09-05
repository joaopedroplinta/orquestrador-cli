import { Box, Text, useInput } from "ink";
import { PINGUIM_BRAILLE_ART } from "./pinguimBraille.js";

export interface PinguimFullscreenProps {
  onDismiss: () => void;
}

// Renderizado no lugar da árvore inteira do App enquanto ativo (ver App.tsx,
// early return antes do JSX normal) — não é uma alt-screen de terminal de
// verdade (Ink não expõe isso), só substitui o que aparece na tela. Qualquer
// tecla dispensa e volta pro chat normal; por isso não tem `disabled`/toggle
// próprio como o PromptInput, é sempre ativo enquanto este componente existe.
export default function PinguimFullscreen({ onDismiss }: PinguimFullscreenProps) {
  useInput(() => {
    onDismiss();
  });

  return (
    <Box flexDirection="column" alignItems="center" paddingY={1}>
      {PINGUIM_BRAILLE_ART.map((line, i) => (
        <Text key={i} color="whiteBright">
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text dimColor>pressione qualquer tecla pra voltar</Text>
      </Box>
    </Box>
  );
}
