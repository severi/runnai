import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { TextInput } from "./TextInput.js";

export interface QuestionOption {
  label: string;
  description: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

interface QuestionState {
  selectedIndex: number | null;
  multiSelected: Set<number>;
  otherText: string;
}

interface QuestionPromptProps {
  questions: AskQuestion[];
  onSubmit: (answers: Record<string, string>) => void;
  onCancel: (reason: "escape" | "chat") => void;
}

export function QuestionPrompt({ questions, onSubmit, onCancel }: QuestionPromptProps) {
  const [activeTab, setActiveTab] = useState(0);
  const [focusedRows, setFocusedRows] = useState<number[]>(
    () => questions.map(() => 0)
  );
  const [questionStates, setQuestionStates] = useState<QuestionState[]>(
    () => questions.map(() => ({
      selectedIndex: null,
      multiSelected: new Set<number>(),
      otherText: "",
    }))
  );
  const [otherActive, setOtherActive] = useState(false);

  const isOnSubmitTab = activeTab === questions.length;
  const currentQ = isOnSubmitTab ? null : questions[activeTab];
  const optionCount = currentQ ? currentQ.options.length : 0;
  const otherRowIndex = optionCount;
  const chatRowIndex = optionCount + 1;
  const totalRows = optionCount + 2;
  const focusedRow = isOnSubmitTab ? 0 : focusedRows[activeTab];
  const isOnOtherRow = !isOnSubmitTab && focusedRow === otherRowIndex;
  const isOnChatRow = !isOnSubmitTab && focusedRow === chatRowIndex;

  const isAnswered = (qi: number): boolean => {
    const s = questionStates[qi];
    const q = questions[qi];
    if (q.multiSelect) return s.multiSelected.size > 0 || s.otherText.trim() !== "";
    return s.selectedIndex !== null || s.otherText.trim() !== "";
  };

  const collectAnswers = useCallback((): Record<string, string> => {
    const answers: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const s = questionStates[i];
      if (q.multiSelect) {
        const labels: string[] = [];
        s.multiSelected.forEach((idx) => labels.push(q.options[idx].label));
        if (s.otherText.trim()) labels.push(s.otherText.trim());
        answers[q.question] = labels.join(", ");
      } else if (s.otherText.trim()) {
        answers[q.question] = s.otherText.trim();
      } else if (s.selectedIndex !== null) {
        answers[q.question] = q.options[s.selectedIndex].label;
      } else {
        answers[q.question] = "";
      }
    }
    return answers;
  }, [questions, questionStates]);

  const setFocusedRow = (tab: number, row: number) => {
    setFocusedRows((prev) => {
      const next = [...prev];
      next[tab] = row;
      return next;
    });
  };

  const updateState = (qi: number, update: Partial<QuestionState>) => {
    setQuestionStates((prev) => {
      const next = [...prev];
      next[qi] = { ...next[qi], ...update };
      return next;
    });
  };

  const advanceTab = useCallback(() => {
    if (activeTab < questions.length) {
      setActiveTab(activeTab + 1);
      setOtherActive(false);
    }
  }, [activeTab, questions.length]);

  // Main keyboard handler — disabled when Other text input is active
  useInput((input, key) => {
    // When Other input is active, only handle Escape to blur it.
    // All other keys (chars, return, arrows) go to the TextInput.
    if (otherActive) {
      if (key.escape) {
        setOtherActive(false);
      }
      return;
    }

    if (key.escape) {
      onCancel("escape");
      return;
    }

    // Tab navigation
    if (key.leftArrow) {
      if (activeTab > 0) setActiveTab(activeTab - 1);
      return;
    }
    if (key.rightArrow || key.tab) {
      if (activeTab < questions.length) setActiveTab(activeTab + 1);
      return;
    }

    // Submit tab
    if (isOnSubmitTab) {
      if (key.return) onSubmit(collectAnswers());
      return;
    }

    // Up/down within question
    if (key.upArrow) {
      setFocusedRow(activeTab, Math.max(0, focusedRow - 1));
      return;
    }
    if (key.downArrow) {
      setFocusedRow(activeTab, Math.min(totalRows - 1, focusedRow + 1));
      return;
    }

    // Enter
    if (key.return) {
      if (isOnChatRow) {
        onCancel("chat");
        return;
      }
      if (isOnOtherRow) {
        setOtherActive(true);
        return;
      }
      // Option row
      if (currentQ!.multiSelect) {
        const ms = new Set(questionStates[activeTab].multiSelected);
        if (ms.has(focusedRow)) ms.delete(focusedRow);
        else ms.add(focusedRow);
        updateState(activeTab, { multiSelected: ms });
      } else {
        updateState(activeTab, { selectedIndex: focusedRow });
        advanceTab();
      }
      return;
    }

    // Space for multi-select toggle
    if (input === " " && currentQ?.multiSelect && focusedRow < optionCount) {
      const ms = new Set(questionStates[activeTab].multiSelected);
      if (ms.has(focusedRow)) ms.delete(focusedRow);
      else ms.add(focusedRow);
      updateState(activeTab, { multiSelected: ms });
    }
  }, { isActive: true });

  // TextInput callbacks for "Other" row
  const handleOtherChange = useCallback((value: string) => {
    updateState(activeTab, { otherText: value });
  }, [activeTab]);

  const handleOtherSubmit = useCallback(() => {
    setOtherActive(false);
    advanceTab();
  }, [advanceTab]);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      {/* Tab bar */}
      <Box>
        <Text dimColor>{"← "}</Text>
        {questions.map((q, i) => {
          const active = activeTab === i;
          const icon = isAnswered(i) ? "✓" : "□";
          return (
            <React.Fragment key={i}>
              <Text
                bold={active}
                backgroundColor={active ? "blue" : undefined}
                color={active ? "white" : "gray"}
              >
                {` ${icon} ${q.header} `}
              </Text>
              <Text> </Text>
            </React.Fragment>
          );
        })}
        <Text
          bold={isOnSubmitTab}
          backgroundColor={isOnSubmitTab ? "blue" : undefined}
          color={isOnSubmitTab ? "white" : "gray"}
        >
          {" ✓ Submit "}
        </Text>
        <Text dimColor>{" →"}</Text>
      </Box>

      {/* Question content */}
      {!isOnSubmitTab && currentQ && (
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text bold wrap="wrap">{currentQ.question}</Text>
          </Box>

          {/* Options */}
          {currentQ.options.map((opt, i) => {
            const focused = focusedRow === i;
            const qs = questionStates[activeTab];
            const selected = currentQ.multiSelect
              ? qs.multiSelected.has(i)
              : qs.selectedIndex === i;
            return (
              <Box key={i} flexDirection="column">
                <Box>
                  <Text color={focused ? "cyan" : undefined}>
                    {focused ? "› " : "  "}
                  </Text>
                  {currentQ.multiSelect && (
                    <Text color={selected ? "cyan" : "gray"}>
                      {selected ? "[✓] " : "[ ] "}
                    </Text>
                  )}
                  <Text bold={focused || selected}>{opt.label}</Text>
                </Box>
                <Box marginLeft={currentQ.multiSelect ? 8 : 4}>
                  <Text dimColor wrap="wrap">{opt.description}</Text>
                </Box>
              </Box>
            );
          })}

          {/* Separator */}
          <Box><Text dimColor>{"─".repeat(40)}</Text></Box>

          {/* Other — free text */}
          <Box>
            <Text color={isOnOtherRow ? "cyan" : undefined}>
              {isOnOtherRow ? "› " : "  "}
            </Text>
            {otherActive && isOnOtherRow ? (
              <TextInput
                value={questionStates[activeTab].otherText}
                onChange={handleOtherChange}
                onSubmit={handleOtherSubmit}
                focus={true}
                placeholder="Type your answer..."
              />
            ) : (
              <Text dimColor={!isOnOtherRow}>
                {questionStates[activeTab].otherText || "Other..."}
              </Text>
            )}
          </Box>

          {/* Chat about this */}
          <Box marginTop={1}>
            <Text color={isOnChatRow ? "yellow" : undefined}>
              {isOnChatRow ? "› " : "  "}
            </Text>
            <Text dimColor={!isOnChatRow} color={isOnChatRow ? "yellow" : undefined}>
              Chat about this
            </Text>
          </Box>
        </Box>
      )}

      {/* Submit tab */}
      {isOnSubmitTab && (
        <Box flexDirection="column" marginTop={1}>
          <Box marginBottom={1}>
            <Text bold>Review your answers:</Text>
          </Box>
          {questions.map((q, i) => {
            const s = questionStates[i];
            let answer: string;
            if (q.multiSelect) {
              const labels: string[] = [];
              s.multiSelected.forEach((idx) => labels.push(q.options[idx].label));
              if (s.otherText.trim()) labels.push(s.otherText.trim());
              answer = labels.join(", ") || "(no answer)";
            } else if (s.otherText.trim()) {
              answer = s.otherText.trim();
            } else if (s.selectedIndex !== null) {
              answer = q.options[s.selectedIndex]?.label ?? "(no answer)";
            } else {
              answer = "(no answer)";
            }
            return (
              <Box key={i}>
                <Text dimColor>{q.header}: </Text>
                <Text>{answer}</Text>
              </Box>
            );
          })}
          <Box marginTop={1}>
            <Text color="cyan">Press Enter to submit</Text>
            <Text dimColor>  ← to go back</Text>
          </Box>
        </Box>
      )}

      {/* Footer */}
      {!isOnSubmitTab && (
        <Box marginTop={1}>
          <Text dimColor>
            {otherActive
              ? "Type your answer · Enter to confirm · Esc to go back"
              : currentQ?.multiSelect
                ? "Space toggle · Enter confirm · ←→ questions · Esc cancel"
                : "Enter to select · ↑↓ navigate · ←→ questions · Esc cancel"
            }
          </Text>
        </Box>
      )}
    </Box>
  );
}
