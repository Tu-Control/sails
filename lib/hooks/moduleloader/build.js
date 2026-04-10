/**
 * sails/lib/hooks/moduleloader/build.js
 *
 * Standalone build utility for pre-generating optimization artifacts
 * (module manifest + service bundle) for production deployments (e.g. Cloud Run).
 *
 * Usage:
 *   node node_modules/sails/bin/sails-build.js
 *   npx sails-build
 *   sails build
 *
 * Only runs if `moduleManifestCache: true` is set in .sailsrc.
 */

var fs = require('fs');
var path = require('path');

var MANIFEST_VERSION = 1;

module.exports = function sailsBuild(appPath) {
  appPath = appPath || process.cwd();

  var BUILD_DIR = path.join(appPath, '.tmp', 'build');
  var MANIFEST_PATH = path.join(BUILD_DIR, 'module-manifest.json');
  var SERVICES_BUNDLE_PATH = path.join(BUILD_DIR, 'services-bundle.js');

  // Read .sailsrc to check if moduleManifestCache is enabled and get paths
  var sailsrc = {};
  try {
    sailsrc = JSON.parse(fs.readFileSync(path.join(appPath, '.sailsrc'), 'utf8'));
  } catch (e) {}

  if (!sailsrc.moduleManifestCache) {
    console.log('⚠️  moduleManifestCache not enabled in .sailsrc. Skipping sails build.');
    return;
  }

  console.log('🚀 Starting Sails Build Optimization...');
  console.log('   appPath:', appPath);

  // Read app package.json for dependency info
  var appPkg = {};
  try {
    appPkg = JSON.parse(fs.readFileSync(path.join(appPath, 'package.json'), 'utf8'));
  } catch (e) {}

  // Ensure build directory exists
  if (!fs.existsSync(BUILD_DIR)) {
    fs.mkdirSync(BUILD_DIR, { recursive: true });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Scan a directory for files matching a filter.
   * @param {string} dirname
   * @param {RegExp} filter
   * @param {Object} opts
   * @param {number} [opts.maxDepth] - Max recursion depth (default: Infinity). Use 1 for root only.
   * @param {boolean} [opts.lowercase] - Lowercase the identity key (default: false).
   * @param {RegExp} [opts.replaceExpr] - Strip directory prefix from identity (e.g. /^.*\//).
   */
  function scanDir(dirname, filter, opts) {
    filter = filter || /\.js$/;
    opts = opts || {};
    var maxDepth = opts.maxDepth !== undefined ? opts.maxDepth : Infinity;
    if (!fs.existsSync(dirname)) return {};
    var results = {};

    function recurse(currentDir, relativePath, depth) {
      relativePath = relativePath || '';
      depth = depth || 0;
      var files = fs.readdirSync(currentDir);
      for (var i = 0; i < files.length; i++) {
        var file = files[i];
        if (file.charAt(0) === '.') continue;
        var fullPath = path.join(currentDir, file);
        var relPath = relativePath ? path.join(relativePath, file) : file;
        var stats = fs.statSync(fullPath);

        if (stats.isDirectory()) {
          if (depth + 1 < maxDepth) {
            recurse(fullPath, relPath, depth + 1);
          }
        } else if (filter.test(file)) {
          var identity = relPath.replace(/\.[^/.]+$/, '').replace(/\\/g, '/');
          if (opts.replaceExpr) { identity = identity.replace(opts.replaceExpr, ''); }
          if (opts.lowercase) { identity = identity.toLowerCase(); }
          results[identity] = fullPath;
        }
      }
    }

    recurse(dirname);
    return results;
  }

  function scanInstalledHooks(nodeModulesDir) {
    if (!fs.existsSync(nodeModulesDir)) return {};
    var installedHooks = {};

    var allDeps = Object.assign(
      {},
      appPkg.dependencies || {},
      appPkg.devDependencies || {},
      appPkg.optionalDependencies || {}
    );

    function checkDir(dir, relPath) {
      relPath = relPath || '';
      var contents;
      try { contents = fs.readdirSync(dir); } catch (e) { return; }

      for (var i = 0; i < contents.length; i++) {
        var item = contents[i];
        if (item.charAt(0) === '.') continue;
        var fullPath = path.join(dir, item);
        var stats;
        try { stats = fs.statSync(fullPath); } catch (e) { continue; }

        // Handle namespaced packages like @sailshq/...
        if (item.charAt(0) === '@') {
          checkDir(fullPath, item);
          continue;
        }

        if (stats.isDirectory()) {
          var pkgJsonPath = path.join(fullPath, 'package.json');
          if (fs.existsSync(pkgJsonPath)) {
            try {
              var pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
              if (pkg.sails && pkg.sails.isHook && allDeps[pkg.name]) {
                var identity = relPath ? path.join(relPath, item) : item;
                installedHooks[identity] = pkg;
              }
            } catch (e) {}
          }
        }
      }
    }

    checkDir(nodeModulesDir);
    return installedHooks;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Build manifest
  // ─────────────────────────────────────────────────────────────────────────

  var manifest = {
    version: MANIFEST_VERSION,
    generatedAt: new Date().toISOString(),
    buildGenerated: true,
    sections: {}
  };

  // 1. Models
  // Match includeAll behavior: caseSensitive:false (lowercase) + replaceExpr:/^.*\// (strip subdir prefix)
  var modelsDir = path.join(appPath, 'api', 'models');
  var models = scanDir(modelsDir, /\.js$/, { lowercase: true, replaceExpr: /^.*\// });
  manifest.sections.models = {
    dirname: modelsDir,
    buildGenerated: true,
    files: models
  };
  console.log('✅ Scanned ' + Object.keys(models).length + ' models');

  // 2. Services
  // Match includeAll behavior: depth:1 (root only) + caseSensitive:true (no lowercase)
  var servicesDir = path.join(appPath, 'api', 'services');
  var services = scanDir(servicesDir, /\.js$/, { maxDepth: 1 });
  manifest.sections.services = {
    dirname: servicesDir,
    buildGenerated: true,
    files: services
  };
  console.log('✅ Scanned ' + Object.keys(services).length + ' services');

  // 3. Bundle services with esbuild (optional - graceful fallback if not available)
  try {
    var esbuild = require('esbuild');
    console.log('📦 Bundling services with esbuild...');

    // Build a CJS entry point that requires all services
    var entryPointContent = 'module.exports = {\n' +
      Object.keys(services)
        .map(function(id) {
          return '  "' + id + '": require("' + services[id].replace(/\\/g, '/') + '"),';
        })
        .join('\n') +
      '\n};';

    var entryPointPath = path.join(BUILD_DIR, 'services-entry.js');
    fs.writeFileSync(entryPointPath, entryPointContent);

    // External: only packages that CANNOT be safely bundled.
    // Everything else (sendgrid, google-cloud, anthropic, etc.) gets inlined →
    // reduces cold start from ~10s to <1s by replacing thousands of require() calls
    // with a single readFile + V8 compile of the bundle.
    var externals = [
      // Sails framework (stateful, complex hooks, must stay external)
      'sails', '@sailshq/lodash', '@sailshq/connect-redis', '@sailshq/include-all',
      'waterline', 'waterline-utils', 'flaverr',

      // Database drivers (have native bindings or stateful pooling)
      'pg', 'pg-native', 'pg-hstore', 'sails-postgresql',

      // Redis (stateful connections managed by sails session hook)
      'redis', 'ioredis',

      // Packages with native .node binaries (cannot be bundled by esbuild)
      'newrelic', '@newrelic/native-metrics',
      '@contrast/agent',
      'pprof',
      'fsevents',
      'bcrypt',
      'deasync',       // native async-to-sync bridge used by http-cookie-agent

      // Waterline adapter hooks (loaded dynamically by ORM, must stay resolvable)
      'sails-hook-orm',
    ];

    var bundleResult = esbuild.buildSync({
      entryPoints: [entryPointPath],
      outfile: SERVICES_BUNDLE_PATH,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: externals,
      logLevel: 'warning',
      // Suppress dynamic require() warnings — services commonly use lazy loading
      // patterns (e.g. require() inside if-blocks) that esbuild can't statically analyze
      ignoreAnnotations: true,
    });
    if (bundleResult.errors && bundleResult.errors.length > 0) {
      console.error('❌ esbuild errors:', bundleResult.errors.length);
      throw new Error('Bundle failed with errors');
    }

    // Clean up temp entry point
    try { fs.unlinkSync(entryPointPath); } catch (e) {}
    console.log('✅ Services bundled → ' + SERVICES_BUNDLE_PATH);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('ℹ️  esbuild not available, skipping service bundle (manifest only).');
    } else {
      console.error('❌ Failed to bundle services:', e.message);
    }
  }

  // 3b. Bundle models with esbuild (single require instead of 184 individual ones)
  // Models are the second-largest directory (184 files) and a major contributor to cold start I/O.
  // Same approach as services bundle: inline all deps except stateful/driver packages.
  try {
    var esbuild = require('esbuild');
    var MODELS_BUNDLE_PATH = path.join(BUILD_DIR, 'models-bundle.js');
    console.log('📦 Bundling models with esbuild...');

    // Entry: exports a dict of { identity: require(path) }
    // identity is lowercase (matching includeAll with flatten:true), path is absolute for esbuild resolution.
    var modelsEntryContent = 'module.exports = {\n' +
      Object.keys(models)
        .map(function(id) {
          return '  "' + id + '": require("' + models[id].replace(/\\/g, '/') + '"),';
        })
        .join('\n') +
      '\n};';

    var modelsEntryPath = path.join(BUILD_DIR, 'models-entry.js');
    fs.writeFileSync(modelsEntryPath, modelsEntryContent);

    // Same externals as services bundle — packages with native bindings, stateful
    // connections, or dynamic require() patterns that cannot be bundled by esbuild.
    var modelsExternals = [
      // Sails framework (stateful, complex hooks, must stay external)
      'sails', '@sailshq/lodash', '@sailshq/connect-redis', '@sailshq/include-all',
      'waterline', 'waterline-utils', 'flaverr',

      // Database drivers (have native bindings or stateful pooling)
      'pg', 'pg-native', 'pg-hstore', 'sails-postgresql',

      // Redis (stateful connections managed by sails session hook)
      'redis', 'ioredis',

      // Packages with native .node binaries (cannot be bundled by esbuild)
      'newrelic', '@newrelic/native-metrics',
      '@contrast/agent',
      'pprof',
      'fsevents',
      'bcrypt',
      'deasync',

      // Waterline adapter hooks (loaded dynamically by ORM, must stay resolvable)
      'sails-hook-orm',
    ];

    var modelsResult = esbuild.buildSync({
      entryPoints: [modelsEntryPath],
      outfile: MODELS_BUNDLE_PATH,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: modelsExternals,
      logLevel: 'warning',
      // Models commonly use require() inside if-blocks and dynamic patterns
      ignoreAnnotations: true,
    });
    if (modelsResult.errors && modelsResult.errors.length > 0) {
      throw new Error('Models bundle failed with errors');
    }
    try { fs.unlinkSync(modelsEntryPath); } catch (e) {}
    console.log('✅ Models bundled → ' + MODELS_BUNDLE_PATH);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('ℹ️  esbuild not available, skipping models bundle (manifest only).');
    } else {
      console.error('❌ Failed to bundle models:', e.message);
    }
  }

  // 3c. Controllers (manifest entry)
  // match include-all behavior: flatten:true, keepDirectoryPath:true, depth:1 root only for traditional controllers
  var controllersDir = path.join(appPath, 'api', 'controllers');
  var controllers = scanDir(controllersDir, /\.js$/, { maxDepth: 1 });
  manifest.sections.controllers = {
    dirname: controllersDir,
    buildGenerated: true,
    files: controllers
  };
  console.log('✅ Scanned ' + Object.keys(controllers).length + ' controllers');

  // 3d. Bundle controllers with esbuild (optional - same approach as services bundle)
  try {
    var esbuild = require('esbuild');
    var CONTROLLERS_BUNDLE_PATH = path.join(BUILD_DIR, 'controllers-bundle.js');
    console.log('📦 Bundling controllers with esbuild...');

    // Entry: exports a dict of { globalId: require(path) }
    // globalId = filename without .js (e.g. "UserController")
    var ctrlEntryContent = 'module.exports = {\n' +
      Object.keys(controllers)
        .map(function(id) {
          return '  "' + id + '": require("' + controllers[id].replace(/\\/g, '/') + '"),';
        })
        .join('\n') +
      '\n};';

    var ctrlEntryPath = path.join(BUILD_DIR, 'controllers-entry.js');
    fs.writeFileSync(ctrlEntryPath, ctrlEntryContent);

    // Controllers mostly use sails globals + service calls — minimal npm deps
    // Same externals as services bundle
    var ctrlExternals = [
      'sails', '@sailshq/lodash', '@sailshq/connect-redis', '@sailshq/include-all',
      'waterline', 'waterline-utils', 'flaverr',
      'pg', 'pg-native', 'pg-hstore', 'sails-postgresql',
      'redis', 'ioredis',
      'newrelic', '@newrelic/native-metrics', '@contrast/agent', 'pprof', 'fsevents', 'bcrypt', 'deasync',
      'sails-hook-orm',
    ];

    var ctrlResult = esbuild.buildSync({
      entryPoints: [ctrlEntryPath],
      outfile: CONTROLLERS_BUNDLE_PATH,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ctrlExternals,
      logLevel: 'warning',
      ignoreAnnotations: true,
    });
    if (ctrlResult.errors && ctrlResult.errors.length > 0) {
      throw new Error('Controllers bundle failed with errors');
    }
    try { fs.unlinkSync(ctrlEntryPath); } catch (e) {}
    console.log('✅ Controllers bundled → ' + CONTROLLERS_BUNDLE_PATH);
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      console.log('ℹ️  esbuild not available, skipping controllers bundle.');
    } else {
      console.error('❌ Failed to bundle controllers:', e.message);
    }
  }

  // 4. Installed hooks (node_modules scan)
  var nmDir = path.join(appPath, 'node_modules');
  var hooks = scanInstalledHooks(nmDir);
  manifest.sections.installedHooks = {
    dirname: nmDir,
    buildGenerated: true,
    data: hooks
  };
  console.log('✅ Scanned ' + Object.keys(hooks).length + ' installed hooks in node_modules');

  // 5. Write manifest
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('✨ Build artifacts generated at: ' + BUILD_DIR);
};
