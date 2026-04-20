import { useEffect, useMemo, useState } from 'react';
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

type QuestionKind = 'multiple' | 'truefalse';

type QuestionOption = {
  id: string;
  text: string;
  isCorrect: boolean;
};

type QuizQuestion = {
  id: string;
  source: string;
  prompt: string;
  kind: QuestionKind;
  options: QuestionOption[];
  correctOptionId: string;
  correctExplanation: string;
  incorrectExplanation: string;
};

type QuizView = 'start' | 'quiz' | 'finished';
type AnswerState = Record<string, string>;

const batchSize = 10;
const pdfUrl = new URL('../Preguntas.pdf', import.meta.url).href;
GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;

function normalizeText(value: string) {
  return value.replace(/\u00ad/g, '').replace(/\s+/g, ' ').trim();
}

function stripQuotes(value: string) {
  return normalizeText(value).replace(/^["“”]+|["“”]+$/g, '').trim();
}

function slugify(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúñü]+/gi, '-')
    .replace(/^-+|-+$/g, '');
}

function createSeed(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function seededShuffle<T>(items: T[], seedValue: string) {
  const result = [...items];
  let seed = createSeed(seedValue);

  for (let index = result.length - 1; index > 0; index -= 1) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const swapIndex = seed % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }

  return result;
}

async function extractPdfText(url: string) {
  const loadingTask = getDocument({ url });
  const pdf = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => {
        const candidate = item as { str?: string };
        return typeof candidate.str === 'string' ? candidate.str : '';
      })
      .join(' ');

    pageTexts.push(pageText);
  }

  return pageTexts.join('\n');
}

function extractIncorrectOptions(rawText: string) {
  const quotedOptions = [...rawText.matchAll(/["“](.*?)["”]/g)]
    .map((match) => stripQuotes(match[1]))
    .filter(Boolean);

  if (quotedOptions.length > 0) {
    return [...new Set(quotedOptions)];
  }

  return rawText
    .replace(/\.$/, '')
    .split(/\s+,\s+|\s+y\s+/i)
    .map(stripQuotes)
    .filter(Boolean);
}

function parseTrueFalseCorrectValue(value: string): 'verdadero' | 'falso' | null {
  const normalized = normalizeText(value).toLowerCase();

  if (/\b(verdadero|true)\b/.test(normalized) || normalized === 'v') {
    return 'verdadero';
  }

  if (/\b(falso|false)\b/.test(normalized) || normalized === 'f') {
    return 'falso';
  }

  return null;
}

function parseQuestionsFromPdfText(text: string) {
  const normalizedText = normalizeText(text);
  const pattern = /Fuente\s+(\d+)\s*●\s*Pregunta(\s*\(V\/F\))?:\s*([\s\S]*?)\s*●\s*Opción correcta:\s*([\s\S]*?)\s*Es correcta porque\s*([\s\S]*?)\s*●\s*Opciones incorrectas:\s*([\s\S]*?)\s*Son incorrectas porque\s*([\s\S]*?)(?=\s*Fuente\s+\d+\s*●|$)/gi;
  const questions: QuizQuestion[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null = null;

  while ((match = pattern.exec(normalizedText)) !== null) {
    const source = match[1];
    const kind: QuestionKind = match[2] ? 'truefalse' : 'multiple';
    const prompt = normalizeText(match[3]);
    const correctText = stripQuotes(match[4]);
    const correctExplanation = normalizeText(match[5]);
    const incorrectTexts = extractIncorrectOptions(match[6]);
    const incorrectExplanation = normalizeText(match[7]);

    if (!prompt || !correctText) {
      continue;
    }

    if (kind === 'multiple' && incorrectTexts.length === 0) {
      continue;
    }

    const candidateKey = `${kind}::${prompt}::${correctText}::${incorrectTexts.join('|')}`;
    if (seen.has(candidateKey)) {
      continue;
    }

    seen.add(candidateKey);

    const baseOptions: QuestionOption[] =
      kind === 'truefalse'
        ? (() => {
            const correctValue = parseTrueFalseCorrectValue(correctText);
            if (!correctValue) {
              return [];
            }

            return [
              {
                id: `vf-verdadero-${source}`,
                text: 'Verdadero',
                isCorrect: correctValue === 'verdadero',
              },
              {
                id: `vf-falso-${source}`,
                text: 'Falso',
                isCorrect: correctValue === 'falso',
              },
            ];
          })()
        : [
            {
              id: `correct-${source}-${slugify(correctText)}`,
              text: correctText,
              isCorrect: true,
            },
            ...incorrectTexts.map((optionText, index) => ({
              id: `wrong-${source}-${index}-${slugify(optionText)}`,
              text: optionText,
              isCorrect: false,
            })),
          ];

    if (baseOptions.length === 0) {
      continue;
    }

    const options = seededShuffle(baseOptions, `${source}-${prompt}`);
    const correctOption = options.find((option) => option.isCorrect) ?? options[0];

    questions.push({
      id: `question-${source}`,
      source,
      prompt,
      kind,
      options,
      correctOptionId: correctOption.id,
      correctExplanation,
      incorrectExplanation,
    });
  }

  return questions.sort((left, right) => Number(left.source) - Number(right.source));
}

function pickRandomQuestions(pool: QuizQuestion[], amount: number) {
  const copy = [...pool];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }

  return copy.slice(0, amount);
}

function createRound(pool: QuizQuestion[], previousSignature: string) {
  const amount = Math.min(batchSize, pool.length);

  if (amount === 0) {
    return { questions: [] as QuizQuestion[], signature: '' };
  }

  let attempts = 0;
  let roundQuestions = pickRandomQuestions(pool, amount);
  let signature = roundQuestions
    .map((question) => question.id)
    .sort()
    .join('|');

  while (pool.length > amount && signature === previousSignature && attempts < 5) {
    roundQuestions = pickRandomQuestions(pool, amount);
    signature = roundQuestions
      .map((question) => question.id)
      .sort()
      .join('|');
    attempts += 1;
  }

  return { questions: roundQuestions, signature };
}

export default function App() {
  const [allQuestions, setAllQuestions] = useState<QuizQuestion[]>([]);
  const [roundQuestions, setRoundQuestions] = useState<QuizQuestion[]>([]);
  const [roundSignature, setRoundSignature] = useState('');
  const [answers, setAnswers] = useState<AnswerState>({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [view, setView] = useState<QuizView>('start');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadQuestions() {
      setIsLoading(true);
      setLoadError(null);

      try {
        const pdfText = await extractPdfText(pdfUrl);
        const parsedQuestions = parseQuestionsFromPdfText(pdfText);

        if (!active) {
          return;
        }

        setAllQuestions(parsedQuestions);
      } catch (error) {
        if (!active) {
          return;
        }

        const message = error instanceof Error ? error.message : 'No se pudo leer el PDF.';
        setLoadError(message);
      } finally {
        if (active) {
          setIsLoading(false);
        }
      }
    }

    loadQuestions().catch((error) => {
      if (!active) {
        return;
      }

      setLoadError(error instanceof Error ? error.message : 'Error inesperado al cargar el PDF.');
      setIsLoading(false);
    });

    return () => {
      active = false;
    };
  }, []);

  const currentQuestion = roundQuestions[currentIndex] ?? null;
  const selectedOptionId = currentQuestion ? answers[currentQuestion.id] : undefined;
  const selectedOption = currentQuestion?.options.find((option) => option.id === selectedOptionId);
  const isAnswered = Boolean(selectedOptionId);
  const isCorrect = Boolean(selectedOption && selectedOption.id === currentQuestion?.correctOptionId);

  const roundResults = useMemo(() => {
    const correct = roundQuestions.filter((question) => answers[question.id] === question.correctOptionId).length;
    const incorrect = roundQuestions.filter((question) => Boolean(answers[question.id]) && answers[question.id] !== question.correctOptionId).length;

    return {
      correct,
      incorrect,
      answered: Object.keys(answers).length,
      total: roundQuestions.length,
    };
  }, [answers, roundQuestions]);

  const failedQuestions = useMemo(
    () =>
      roundQuestions
        .filter((question) => {
          const selectedId = answers[question.id];
          return Boolean(selectedId) && selectedId !== question.correctOptionId;
        })
        .map((question) => {
          const selectedId = answers[question.id];
          const selected = question.options.find((option) => option.id === selectedId) ?? null;
          const correct = question.options.find((option) => option.id === question.correctOptionId) ?? null;

          return {
            question,
            selected,
            correct,
          };
        }),
    [answers, roundQuestions],
  );

  function startNewRandomRound() {
    if (!allQuestions.length) {
      return;
    }

    const nextRound = createRound(allQuestions, roundSignature);
    setRoundQuestions(nextRound.questions);
    setRoundSignature(nextRound.signature);
    setAnswers({});
    setCurrentIndex(0);
    setView('quiz');
  }

  function handleSelectOption(optionId: string) {
    if (!currentQuestion || isAnswered) {
      return;
    }

    setAnswers((current) => ({
      ...current,
      [currentQuestion.id]: optionId,
    }));
  }

  function goToNextQuestion() {
    if (!isAnswered) {
      return;
    }

    if (currentIndex >= roundQuestions.length - 1) {
      setView('finished');
      return;
    }

    setCurrentIndex((value) => value + 1);
  }

  if (view === 'start') {
    return (
      <main className="start-screen">
        <section className="start-card">
          <h1>Quiz de preguntas</h1>
          {isLoading ? <p>Cargando preguntas desde el PDF...</p> : null}
          {loadError ? <p className="error-text">{loadError}</p> : null}
          {!isLoading && !loadError ? (
            <p>Se cargarán 10 preguntas al azar. Responde una por una.</p>
          ) : null}
          <button
            type="button"
            className="start-button"
            onClick={startNewRandomRound}
            disabled={isLoading || Boolean(loadError) || allQuestions.length === 0}
          >
            Comenzar
          </button>
        </section>
      </main>
    );
  }

  if (view === 'finished') {
    return (
      <main className="quiz-screen">
        <section className="panel-card">
          <h2>Resultado final</h2>
          <p>
            Correctas: <strong>{roundResults.correct}</strong> | Incorrectas: <strong>{roundResults.incorrect}</strong>
          </p>
          <button type="button" className="primary-button" onClick={startNewRandomRound}>
            Volver a empezar con otras 10
          </button>
        </section>

        <section className="panel-card">
          <h2>Preguntas incorrectas y explicación</h2>
          {failedQuestions.length === 0 ? (
            <p>No fallaste ninguna pregunta en esta ronda.</p>
          ) : (
            <div className="failed-list">
              {failedQuestions.map(({ question, selected, correct }, index) => (
                <article className="failed-item" key={`failed-${question.id}`}>
                  <p className="failed-label">Error {index + 1}</p>
                  <h3>{question.prompt}</h3>
                  <p>
                    <strong>Tu respuesta:</strong> {selected?.text ?? 'Sin respuesta'}
                  </p>
                  <p>
                    <strong>Respuesta correcta:</strong> {correct?.text ?? 'No disponible'}
                  </p>
                  <p>
                    <strong>Explicación correcta:</strong> {question.correctExplanation}
                  </p>
                  <p>
                    <strong>Explicación del error:</strong> {question.incorrectExplanation}
                  </p>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    );
  }

  return (
    <main className="quiz-screen">
      <section className="panel-card question-panel">
        <p className="progress-text">
          Pregunta {currentIndex + 1} de {roundQuestions.length}
        </p>
        <h2>{currentQuestion?.prompt}</h2>

        <div className="options-list">
          {currentQuestion?.options.map((option) => {
            const isSelected = option.id === selectedOptionId;
            return (
              <button
                key={option.id}
                type="button"
                className={`option-button ${isSelected ? 'selected' : ''}`}
                onClick={() => handleSelectOption(option.id)}
                disabled={isAnswered}
              >
                {option.text}
              </button>
            );
          })}
        </div>

        {isAnswered ? (
          <div className={`feedback-box ${isCorrect ? 'correct' : 'incorrect'}`}>
            <p className="feedback-title">{isCorrect ? 'Respuesta correcta' : 'Respuesta incorrecta'}</p>
            <p>
              <strong>Respuesta elegida:</strong> {selectedOption?.text}
            </p>
            <p>
              <strong>Respuesta correcta:</strong>{' '}
              {currentQuestion?.options.find((option) => option.id === currentQuestion.correctOptionId)?.text}
            </p>
            <p>
              <strong>Por qué es correcta:</strong> {currentQuestion?.correctExplanation}
            </p>
            {!isCorrect ? (
              <p>
                <strong>Por qué no era correcta tu opción:</strong> {currentQuestion?.incorrectExplanation}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="hint-text">Selecciona una opción para ver la corrección y explicación.</p>
        )}

        <button
          type="button"
          className="primary-button"
          onClick={goToNextQuestion}
          disabled={!isAnswered}
        >
          {currentIndex >= roundQuestions.length - 1 ? 'Finalizar' : 'Siguiente'}
        </button>
      </section>
    </main>
  );
}
