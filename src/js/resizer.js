const MIN_PANE_PX = 150;
const mainDivider = document.getElementById('divider-main');
const editorPane = document.getElementById('editor-pane');
const workspace = document.getElementById('workspace');

function getOrientation(event) {
  const isHorizontal = window.innerWidth > 900;
  const dividerSize = isHorizontal 
    ? mainDivider.offsetWidth 
    : mainDivider.offsetHeight;
  const workspaceSize = isHorizontal 
    ? workspace.offsetWidth 
    : workspace.offsetHeight;

  return {
    totalPx: workspaceSize,
    availablePx: workspaceSize - dividerSize,
    currentEditorPx: isHorizontal ? editorPane.offsetWidth : editorPane.offsetHeight,
    adjustmentPx: isHorizontal ? event.movementX : event.movementY
  };
}

function resizePanes(event) {
  const { totalPx, availablePx, currentEditorPx, adjustmentPx } = getOrientation(event);

  // We'll get pixel width / height to then convert to %
  // New editor width / height leaves min 150px for both editor and right pane width 
  // (meaning, max editor width of total width or height - divider width or height - 150 px)
  let newEditorPx = Math.max(
    Math.min(
      currentEditorPx + adjustmentPx, 
      availablePx - MIN_PANE_PX
    ), MIN_PANE_PX
  );

  // Adjust editor width / height. Right pane width / height will flex accordingly.
  let newEditorPxPct = newEditorPx / totalPx;
  editorPane.style.flexBasis = `${newEditorPxPct * 100}%`;
}

export function initializeResizer() {
  let isDragging = false;

  const app = document.getElementById('app');

  mainDivider.addEventListener('mousedown', () => {
    isDragging = true;
  });

  app.addEventListener('mousemove', event => {
    if (!isDragging) {
      return;
    }

    resizePanes(event);
  });
  
  app.addEventListener('mouseup', event => {
    isDragging = false;
  });
}