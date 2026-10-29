/**
 * Test fixture for the extension hook: an extension whose `tools` is present
 * but is not an array. The registry must reject its tools with one warning and
 * keep loading the modules after it. Loaded only when a test points
 * CODEGRAPH_EXTENSION_MODULES at it.
 */
'use strict';

module.exports = { extension: { name: 'bad', tools: {} } };
