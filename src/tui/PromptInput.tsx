import { Text, useInput } from "ink";
import { useRef, useState } from "react";

export interface PromptInputProps {
  onSubmit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

// Não usa `ink-text-input`: aquele componente computa o próximo valor a partir
// da prop `value` capturada no último render ("originalValue"), e chama
// onChange(nextValue) já pronto. Se duas teclas chegam em sequência rápida
// demais pro React re-renderizar entre uma e outra (digitação em rajada, ou
// múltiplos bytes chegando juntos no stdin), o segundo cálculo enxerga a prop
// desatualizada e descarta o primeiro caractere — bug real, reproduzido tanto
// com PTY real quanto com ink-testing-library (ver App.test.tsx).
//
// Aqui o texto atual mora numa ref (`valueRef`), mutada de forma síncrona e
// imediata a cada tecla — nunca depende do valor de uma prop/closure de
// render anterior. `display` (useState) existe só pra disparar o re-render;
// o valor que ela recebe é sempre `valueRef.current` no momento da chamada,
// nunca um cálculo incremental que possa ficar obsoleto.
export default function PromptInput({ onSubmit, placeholder = "", disabled = false }: PromptInputProps) {
  const valueRef = useRef("");
  const [display, setDisplay] = useState("");

  useInput(
    (input, key) => {
      if (key.upArrow || key.downArrow || key.tab || (key.ctrl && input === "c")) {
        return;
      }

      if (key.return) {
        const value = valueRef.current;
        valueRef.current = "";
        setDisplay("");
        onSubmit(value);
        return;
      }

      if (key.backspace || key.delete) {
        valueRef.current = valueRef.current.slice(0, -1);
        setDisplay(valueRef.current);
        return;
      }

      // Um "input" pode ter mais de um caractere (colar texto, ou vários bytes
      // chegando juntos) — sempre acrescido de uma vez, nunca perde nada.
      // \r/\n embutidos são descartados (prompt de uma linha só); não tentamos
      // auto-submeter nesse caso, mesma cautela do próprio Ink com paste.
      const cleaned = input.replace(/[\r\n]/g, "");
      if (cleaned) {
        valueRef.current += cleaned;
        setDisplay(valueRef.current);
      }
    },
    { isActive: !disabled },
  );

  if (disabled) {
    return <Text> </Text>;
  }

  if (display.length > 0) {
    return (
      <Text>
        {display}
        <Text inverse> </Text>
      </Text>
    );
  }

  if (placeholder.length === 0) {
    return (
      <Text>
        <Text inverse> </Text>
      </Text>
    );
  }

  return (
    <Text>
      <Text inverse>{placeholder.slice(0, 1)}</Text>
      <Text dimColor>{placeholder.slice(1)}</Text>
    </Text>
  );
}
