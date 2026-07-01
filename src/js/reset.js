export function initializeResetBtn() {
  const resetBtn = document.getElementById('reset-btn');
  resetBtn.addEventListener('click', () => {
    document.getElementById('output-empty').hidden = false;
    document.getElementById('output-populated').hidden = true;
  });
}