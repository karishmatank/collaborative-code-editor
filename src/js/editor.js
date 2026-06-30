import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

self.MonacoEnvironment = {
  getWorker(moduleId, label) {
    if (label === 'typescript' || label === 'javascript') {
      return new tsWorker();
    }
    if (label === 'html') {
      return new htmlWorker();
    }
    return new editorWorker();
  }
};

let editorInstance = null;

export function initializeEditor(language = 'python') {
  // TODO: Persistence layer should fill in the language

  editorInstance = monaco.editor.create(document.getElementById('monaco-container'), {
    value: '',
    language: language,
    theme: 'vs-dark',
    automaticLayout: true,
    scrollBeyondLastLine: false,
    minimap: { enabled: false },
    fontSize: 14,
    'html.suggest.html5': true,
    autoClosingBrackets: 'always',
    autoClosingTags: 'always', // Doesn't actually produce closing tag for HTML, known issue in Monaco
    tabSize: language === 'python' ? 4 : 2,
    insertSpaces: true,
    detectIndentation: false
  });
  const languageDropdown = document.getElementById('language-select');

  // Set the dropdown to sync with initial language
  languageDropdown.value = language;

  // Language dropdown listener to change editor
  languageDropdown.addEventListener('change', event => {
    const newLanguage = event.target.value;

    // Change the language
    monaco.editor.setModelLanguage(editorInstance.getModel(), newLanguage);

    // Update tab size based on language
    editorInstance.getModel().updateOptions({
      tabSize: newLanguage === 'python' ? 4 : 2,
    });
  });
}