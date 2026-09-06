import { Box, Text, useInput } from "ink";
import { useMemo, useRef, useState } from "react";
import Autocomplete from "./Autocomplete.js";
import { getCommandSuggestions, type SlashCommandDef } from "./commands.js";

export interface PromptInputProps {
  onSubmit: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export default function PromptInput({
  onSubmit,
  placeholder = "",
  disabled = false,
}: PromptInputProps) {
  const valueRef = useRef("");
  const [display, setDisplay] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Histórico de inputs enviados na sessão
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef<number>(-1);
  const tempSavedInputRef = useRef<string>("");

  const suggestions: SlashCommandDef[] = useMemo(() => {
    return getCommandSuggestions(display);
  }, [display]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        return;
      }

      // Autocomplete ativo quando há sugestões disponíveis
      const isAutocompleteActive = suggestions.length > 0;

      if (key.upArrow) {
        if (isAutocompleteActive) {
          setSelectedIndex((prev) => (prev > 0 ? prev - 1 : suggestions.length - 1));
          return;
        }

        // Navegação de histórico (↑)
        const hist = historyRef.current;
        if (hist.length === 0) return;

        if (historyIndexRef.current === -1) {
          tempSavedInputRef.current = valueRef.current;
          historyIndexRef.current = hist.length - 1;
        } else if (historyIndexRef.current > 0) {
          historyIndexRef.current -= 1;
        }

        const targetValue = hist[historyIndexRef.current] ?? "";
        valueRef.current = targetValue;
        setDisplay(targetValue);
        return;
      }

      if (key.downArrow) {
        if (isAutocompleteActive) {
          setSelectedIndex((prev) => (prev < suggestions.length - 1 ? prev + 1 : 0));
          return;
        }

        // Navegação de histórico (↓)
        const hist = historyRef.current;
        if (hist.length === 0 || historyIndexRef.current === -1) return;

        if (historyIndexRef.current < hist.length - 1) {
          historyIndexRef.current += 1;
          const targetValue = hist[historyIndexRef.current] ?? "";
          valueRef.current = targetValue;
          setDisplay(targetValue);
        } else {
          historyIndexRef.current = -1;
          valueRef.current = tempSavedInputRef.current;
          setDisplay(tempSavedInputRef.current);
        }
        return;
      }

      if (key.tab) {
        if (isAutocompleteActive && suggestions[selectedIndex]) {
          const selected = suggestions[selectedIndex];
          const completed = `/${selected.name} `;
          valueRef.current = completed;
          setDisplay(completed);
          setSelectedIndex(0);
        }
        return;
      }

      if (key.return) {
        const value = valueRef.current;
        valueRef.current = "";
        setDisplay("");
        setSelectedIndex(0);
        historyIndexRef.current = -1;

        if (value.trim().length > 0) {
          historyRef.current.push(value);
        }

        onSubmit(value);
        return;
      }

      if (key.backspace || key.delete) {
        valueRef.current = valueRef.current.slice(0, -1);
        setDisplay(valueRef.current);
        setSelectedIndex(0);
        return;
      }

      // Um "input" pode ter mais de um caractere (colar texto ou múltiplos bytes)
      const cleaned = input.replace(/[\r\n]/g, "");
      if (cleaned) {
        valueRef.current += cleaned;
        setDisplay(valueRef.current);
        setSelectedIndex(0);
      }
    },
    { isActive: !disabled },
  );

  if (disabled) {
    return <Text> </Text>;
  }

  return (
    <Box flexDirection="column">
      {suggestions.length > 0 && (
        <Box marginBottom={1}>
          <Autocomplete suggestions={suggestions} selectedIndex={selectedIndex} />
        </Box>
      )}
      {display.length > 0 ? (
        <Text>
          {display}
          <Text inverse> </Text>
        </Text>
      ) : placeholder.length === 0 ? (
        <Text>
          <Text inverse> </Text>
        </Text>
      ) : (
        <Text>
          <Text inverse>{placeholder.slice(0, 1)}</Text>
          <Text dimColor>{placeholder.slice(1)}</Text>
        </Text>
      )}
    </Box>
  );
}
