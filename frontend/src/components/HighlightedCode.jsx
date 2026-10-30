import { Fragment, useMemo } from 'react';
import { tokenize } from '../utils/syntaxHighlight';

export function HighlightedCode({ content, language }) {
  const tokens = useMemo(() => tokenize(content, language), [content, language]);
  if (!tokens) return <code>{content}</code>;
  return <code>{tokens.map((token, index) => token.type
    ? <span key={index} className={`tok tok-${token.type}`}>{token.text}</span>
    : <Fragment key={index}>{token.text}</Fragment>)}</code>;
}
