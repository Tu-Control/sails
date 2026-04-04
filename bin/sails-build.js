/**
 * `sails build`
 *
 * Pre-generate module manifest and service bundles for production deployments.
 * Reads .sailsrc to determine if moduleManifestCache is enabled.
 *
 * @stability 3
 */

module.exports = function() {
  var build = require('../lib/hooks/moduleloader/build');
  build(process.cwd());
};
