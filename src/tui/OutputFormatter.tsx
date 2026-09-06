import { Box, Text } from "ink";

export interface OutputFormatterProps {
  text: string;
}

interface Block {
  type: "text" | "code" | "diff";
  content: string;
  lang?: string;
}

function parseBlocks(raw: string): Block[] {
  const blocks: Block[] = [];
  const lines = raw.split("\n");
  let currentBlock: string[] = [];
  let inCode = false;
  let codeLang = "";

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        // Fim do bloco de código
        const content = currentBlock.join("\n");
        const isDiff = codeLang.toLowerCase() === "diff" || (!codeLang && currentBlock.some((l) => l.startsWith("+ ") || l.startsWith("- ") || l.startsWith("@@")));
        blocks.push({
          type: isDiff ? "diff" : "code",
          content,
          lang: codeLang || undefined,
        });
        currentBlock = [];
        inCode = false;
        codeLang = "";
      } else {
        // Início do bloco de código
        if (currentBlock.length > 0) {
          blocks.push({ type: "text", content: currentBlock.join("\n") });
          currentBlock = [];
        }
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
    } else {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    if (inCode) {
      blocks.push({ type: "code", content: currentBlock.join("\n"), lang: codeLang });
    } else {
      blocks.push({ type: "text", content: currentBlock.join("\n") });
    }
  }

  return blocks;
}

function renderDiffLine(line: string, index: number) {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return (
      <Text key={index} color="green">
        {line}
      </Text>
    );
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return (
      <Text key={index} color="red">
        {line}
      </Text>
    );
  }
  if (line.startsWith("@@")) {
    return (
      <Text key={index} color="cyan">
        {line}
      </Text>
    );
  }
  return (
    <Text key={index} dimColor>
      {line}
    </Text>
  );
}

function renderFormattedLine(line: string, index: number) {
  const trimmed = line.trim();

  // Cabeçalhos Markdown (#, ##, ###)
  if (trimmed.startsWith("#")) {
    const level = trimmed.match(/^#+/)?.[0].length ?? 1;
    const title = trimmed.replace(/^#+\s*/, "");
    return (
      <Box key={index} marginY={0}>
        <Text bold color={level === 1 ? "cyan" : level === 2 ? "yellow" : "white"}>
          {title}
        </Text>
      </Box>
    );
  }

  // Lista de itens (- item ou * item)
  if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
    const itemText = trimmed.slice(2);
    return (
      <Box key={index} paddingLeft={1}>
        <Text color="cyan">• </Text>
        <Text>{itemText}</Text>
      </Box>
    );
  }

  return (
    <Text key={index}>
      {line}
    </Text>
  );
}

export default function OutputFormatter({ text }: OutputFormatterProps) {
  if (!text || text.trim().length === 0) {
    return <Text dimColor>(sem saída)</Text>;
  }

  const blocks = parseBlocks(text);

  return (
    <Box flexDirection="column">
      {blocks.map((block, bIdx) => {
        if (block.type === "diff") {
          const diffLines = block.content.split("\n");
          return (
            <Box
              key={bIdx}
              flexDirection="column"
              borderStyle="single"
              borderColor="gray"
              paddingX={1}
              marginY={1}
            >
              <Text bold color="yellow">
                DIFF {block.lang ? `(${block.lang})` : ""}
              </Text>
              {diffLines.map((line, lIdx) => renderDiffLine(line, lIdx))}
            </Box>
          );
        }

        if (block.type === "code") {
          return (
            <Box
              key={bIdx}
              flexDirection="column"
              borderStyle="round"
              borderColor="gray"
              paddingX={1}
              marginY={1}
            >
              {block.lang && (
                <Text dimColor bold>
                  {block.lang}
                </Text>
              )}
              <Text color="white">{block.content}</Text>
            </Box>
          );
        }

        const lines = block.content.split("\n");
        return (
          <Box key={bIdx} flexDirection="column">
            {lines.map((line, lIdx) => renderFormattedLine(line, lIdx))}
          </Box>
        );
      })}
    </Box>
  );
}
