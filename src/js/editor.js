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
  });
  const languageDropdown = document.getElementById('language-select');

  // Set the dropdown to sync with initial language
  languageDropdown.value = language;

  // Language dropdown listener to change editor
  languageDropdown.addEventListener('change', event => {
    monaco.editor.setModelLanguage(editorInstance.getModel(), event.target.value);
  });
}