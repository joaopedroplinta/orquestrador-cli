import { Box, Text } from "ink";
import type { SlashCommandDef } from "./commands.js";

export interface AutocompleteProps {
  suggestions: SlashCommandDef[];
  selectedIndex: number;
  maxVisible?: number;
}

export default function Autocomplete({
  suggestions,
  selectedIndex,
  maxVisible = 6,
}: AutocompleteProps) {
  if (suggestions.length === 0) {
    return null;
  }

  // Janela deslizante de visualização
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), suggestions.length - maxVisible),
  );
  const visibleItems = suggestions.slice(start, start + maxVisible);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
      marginBottom={0}
    >
      <Box marginBottom={0}>
        <Text bold color="magenta">
          Comandos disponíveis
        </Text>
        <Text dimColor> (↑/↓ navegar · Tab/Enter selecionar)</Text>
      </Box>
      {visibleItems.map((item, i) => {
        const itemIndex = start + i;
        const isSelected = itemIndex === selectedIndex;

        return (
          <Box key={item.name} flexDirection="row" justifyContent="space-between">
            <Box>
              <Text color={isSelected ? "cyan" : "gray"}>{isSelected ? "❯ " : "  "}</Text>
              <Text bold={isSelected} color={isSelected ? "white" : "green"}>
                {item.synopsis.padEnd(26)}
              </Text>
              <Text dimColor={!isSelected} color={isSelected ? "gray" : undefined}>
                {item.description}
              </Text>
            </Box>
          </Box>
        );
      })}
      {suggestions.length > maxVisible && (
        <Text dimColor>
          + {suggestions.length - maxVisible} comandos adicionais...
        </Text>
      )}
    </Box>
  );
}
