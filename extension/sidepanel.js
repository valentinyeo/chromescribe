// Get the URL from the extension and load it in the iframe
chrome.runtime.sendMessage({ action: "getTerminalUrl" }, (response) => {
  if (response && response.url) {
    document.getElementById("loading").style.display = "none";
    document.getElementById("terminal").style.display = "block";
    document.getElementById("terminal").src = response.url;
  } else {
    document.getElementById("loading").textContent = "Click the extension icon first to process a page.";
  }
});
