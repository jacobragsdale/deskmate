/**
 * Stands in for react-style-singleton, which vite.config.ts points here. Radix's modal dialogs use it to write a <style> element that stops the page behind them scrolling.
 * The page's content security policy refuses any <style> element that is not one of the app's files, and the page itself never scrolls (its panes do), so this writes nothing.
 */
export function styleSingleton(): () => null {
  return () => null;
}
