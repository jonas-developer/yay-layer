
function killApp() {
  localStorage.setItem('kill', "1");
}

module.exports = { killApp };

function xTractCode() {
  localStorage.setItem('xtractCode', "1");
}

module.exports = { xTractCode };
