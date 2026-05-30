import { clean } from "./codex-app-server-common.js";

function userInputQuestionKey(question = {}, index = 0) {
  return clean(question.id || question.header || `question_${index + 1}`) || `question_${index + 1}`;
}

function answerOptionLabel(question = {}, value = "") {
  const text = clean(value);
  const options = Array.isArray(question.options) ? question.options : [];
  if (!text || !options.length) return text;
  const numeric = text.match(/^\d+$/);
  const numericIndex = numeric ? Number(numeric[0]) - 1 : -1;
  if (numericIndex >= 0 && numericIndex < options.length) return clean(options[numericIndex]?.label) || text;
  const alpha = text.match(/^[a-z]$/i);
  const alphaIndex = alpha ? alpha[0].toLowerCase().charCodeAt(0) - "a".charCodeAt(0) : -1;
  if (alphaIndex >= 0 && alphaIndex < options.length) return clean(options[alphaIndex]?.label) || text;
  const normalized = text.toLowerCase();
  const matched = options.find((option) => clean(option?.label).toLowerCase() === normalized);
  return clean(matched?.label) || text;
}

function indexedUserInputAnswers(text = "") {
  const answers = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = clean(line).match(/^(?:q(?:uestion)?\s*)?(\d+)[\).:\-]\s*(.+)$/i);
    if (!match) continue;
    const index = Number(match[1]);
    const answer = clean(match[2]);
    if (Number.isFinite(index) && index > 0 && answer) answers.set(index, answer);
  }
  return answers;
}

export function requestUserInputAnswers(request = {}, text = "") {
  const answerText = clean(text);
  const questions = Array.isArray(request.params?.questions) ? request.params.questions : [];
  if (!questions.length) return answerText ? { answer: answerText } : {};
  const indexed = indexedUserInputAnswers(answerText);
  const answers = {};
  questions.forEach((question, index) => {
    const raw = indexed.get(index + 1) || (questions.length === 1 ? answerText : "");
    if (!raw) return;
    answers[userInputQuestionKey(question, index)] = answerOptionLabel(question, raw);
  });
  if (!Object.keys(answers).length && answerText) {
    answers[userInputQuestionKey(questions[0], 0)] = answerOptionLabel(questions[0], answerText);
  }
  return answers;
}
