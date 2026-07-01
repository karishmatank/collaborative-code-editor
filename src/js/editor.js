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

class PadEditorController {
  constructor(padId) {
    this.padId = padId;
    this.models = {}; // key is language, value is model
    this.editor = monaco.editor.create(
      document.getElementById('monaco-container'), {
        theme: 'vs-dark',
        automaticLayout: true,
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        fontSize: 14,
        autoClosingBrackets: 'always',
        autoClosingTags: 'always', // Doesn't actually produce closing tag for HTML, known issue in Monaco
        insertSpaces: true,
        detectIndentation: false
      }
    );
  }

  static tabSizeFor(language) {
    return language === 'python' ? 4 : 2;
  }

  // Get or create a new model per language, then mount it
  switchLanguage(language) {
    let model = this.models[language];
    if (!model) {
      // TODO: Get initial text from persistence layer
      const initialText = '';
      model = monaco.editor.createModel(initialText, language);
      this.models[language] = model;
    }

    this.editor.setModel(model);
    this.editor.getModel().updateOptions({
      tabSize: PadEditorController.tabSizeFor(language),
    });
  }

  // Dispose of the model when the user is done
  // Note that this is not shared across users, this is specific to each user
  // in their own browser
  // We need to explicitly dispose each model, otherwise they won't be garbage collected
  // Relevant more so for an SPA set up if we were to switch pads
  // Tear down is automatic if the browser tab is closed or user navigates away given real page loads
  dispose() {
    Object.values(this.models).forEach(model => model.dispose());
    this.models = {};
    this.editor = null;
  }
}

export function initializeEditor(language = 'python') {
  // TODO: Insert in the padId once we can get it from the URL
  // const padId = window.location.pathname.split('/').pop();
  const padId = null;
  let controller = new PadEditorController(padId);
  controller.switchLanguage(language);

  // Set the dropdown to sync with initial language
  const languageDropdown = document.getElementById('language-select');
  languageDropdown.value = language;

  // Language dropdown listener to change editor
  languageDropdown.addEventListener('change', event => {
    controller.switchLanguage(event.target.value);
  });
}