/**
 * Test fixture for the extension hook: a module that throws, at load, a value
 * that cannot be converted to a string (a null-prototype object, so
 * `String(value)` itself throws). The registry must warn and keep loading the
 * modules after it. Loaded only when a test points
 * CODEGRAPH_EXTENSION_MODULES at it.
 */
'use strict';

throw Object.create(null);
