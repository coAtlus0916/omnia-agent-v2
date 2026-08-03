'use strict';
function createOperationHandler() {
  return Object.freeze({
    async run() {
      throw new Error('Recording uses the dedicated Connector recording command gate; no HTTP Operation is exposed.');
    }
  });
}
module.exports = Object.freeze({ createOperationHandler });
