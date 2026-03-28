document.getElementById("btn-pi").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    chrome.runtime.sendMessage({ action: "process", tab });
    window.close();
  });
});
