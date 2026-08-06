const path = require("node:path");

function basename(value) {
  return path.basename(value);
}

module.exports = basename;
