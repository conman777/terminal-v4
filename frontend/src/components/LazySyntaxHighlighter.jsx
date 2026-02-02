import { useEffect, useState } from 'react';

let cachedHighlighter = null;
let cachedTheme = null;
let loadingPromise = null;

async function loadHighlighter() {
  if (cachedHighlighter && cachedTheme) {
    return { SyntaxHighlighter: cachedHighlighter, theme: cachedTheme };
  }
  if (!loadingPromise) {
    loadingPromise = Promise.all([
      import('react-syntax-highlighter'),
      import('react-syntax-highlighter/dist/esm/styles/prism')
    ]).then(([highlighterModule, styleModule]) => {
      cachedHighlighter = highlighterModule.Prism;
      cachedTheme = styleModule.oneDark;
      return { SyntaxHighlighter: cachedHighlighter, theme: cachedTheme };
    });
  }
  return loadingPromise;
}

export function LazySyntaxHighlighter({
  language = 'text',
  customStyle,
  children,
  ...props
}) {
  const [loaded, setLoaded] = useState(() => (
    cachedHighlighter && cachedTheme
      ? { SyntaxHighlighter: cachedHighlighter, theme: cachedTheme }
      : null
  ));

  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    loadHighlighter()
      .then((result) => {
        if (!cancelled) {
          setLoaded(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  if (!loaded) {
    return (
      <pre className="lazy-syntax-fallback" style={customStyle}>
        <code>{children}</code>
      </pre>
    );
  }

  const { SyntaxHighlighter, theme } = loaded;
  return (
    <SyntaxHighlighter
      style={theme}
      language={language}
      PreTag="div"
      customStyle={customStyle}
      {...props}
    >
      {children}
    </SyntaxHighlighter>
  );
}
