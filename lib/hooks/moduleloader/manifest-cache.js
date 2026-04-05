var fs = require('fs');
var path = require('path');
var _ = require('@sailshq/lodash');

var MANIFEST_VERSION = 1;

/**
 * manifest-cache.js
 *
 * Utility to load/save modules from a manifest file to avoid
 * expensive filesystem scans (readdirSync/statSync).
 */

module.exports = {

  /**
   * Intenta cargar módulos desde el manifest cache.
   * Retorna null si el cache no existe, es inválido o la sección no coincide.
   */
  loadFromManifest: function(manifestPath, sectionName, options) {
    try {
      if (!fs.existsSync(manifestPath)) {
        console.log('[manifest-cache] MISS [' + sectionName + ']: manifest file not found at', manifestPath);
        return null;
      }

      var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      // Validar versión y estructura básica
      if (manifest.version !== MANIFEST_VERSION) {
        console.log('[manifest-cache] MISS [' + sectionName + ']: version mismatch (manifest=' + manifest.version + ' expected=' + MANIFEST_VERSION + ')');
        return null;
      }
      if (!manifest.sections || !manifest.sections[sectionName]) {
        console.log('[manifest-cache] MISS [' + sectionName + ']: section not found in manifest. Available:', Object.keys(manifest.sections || {}));
        return null;
      }

      var section = manifest.sections[sectionName];

      // Validar que el directorio base sea el mismo
      if (section.dirname !== options.dirname) {
        console.log('[manifest-cache] MISS [' + sectionName + ']: dirname mismatch (manifest="' + section.dirname + '" runtime="' + options.dirname + '")');
        return null;
      }

      // Validar mtime del directorio (detecta archivos agregados/eliminados/renombrados)
      // Si fue pre-generado en el build, omitimos la validación de mtime porque en Docker suele cambiar.
      if (!section.buildGenerated) {
        var stats = fs.statSync(section.dirname);
        if (Math.floor(stats.mtimeMs) !== section.dirMtime) {
          console.log('[manifest-cache] MISS [' + sectionName + ']: mtime changed (manifest=' + section.dirMtime + ' current=' + Math.floor(stats.mtimeMs) + ')');
          return null;
        }
      }

      // Si todo es válido, cargar los archivos
      var modules = {};
      
      // Caso especial para installedHooks (ya están procesados)
      if (sectionName === 'installedHooks') {
        console.log('[manifest-cache] HIT [' + sectionName + ']: loaded from cache');
        return section.data;
      }

      // Caso general para modelos, servicios, etc.
      for (var identity in section.files) {
        var filePath = section.files[identity];
        // require() se encarga de cargar el código
        modules[identity] = require(filePath);
      }

      console.log('[manifest-cache] HIT [' + sectionName + ']: loaded ' + Object.keys(modules).length + ' modules from cache');
      return modules;
    } catch (e) {
      // Fallback graceful a scan normal si algo falla
      console.log('[manifest-cache] ERROR [' + sectionName + ']: ' + e.message);
      return null;
    }
  },

  /**
   * Guarda el resultado de un scan al manifest.
   */
  saveToManifest: function(manifestPath, sectionName, options, modules) {
    try {
      var manifest = {
        version: MANIFEST_VERSION,
        generatedAt: new Date().toISOString(),
        sections: {}
      };

      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
          // Si está corrupto, empezamos de nuevo
        }
      }

      var stats = fs.statSync(options.dirname);
      var section = {
        dirname: options.dirname,
        dirMtime: Math.floor(stats.mtimeMs),
        files: {}
      };

      if (sectionName === 'installedHooks') {
        section.data = modules;
      } else {
        // Mapear el diccionario de módulos a paths de archivos
        // Esto es un poco truco porque include-all no nos da los paths directamente
        // Pero como sabemos el dirname y el identity (nombre de archivo sin ext), podemos inferirlo
        // o mejor aún, confiar en que el scan acaba de ocurrir y los archivos existen.
        
        // Para ser precisos, solo guardamos lo que realmente se cargó.
        for (var identity in modules) {
          // Intentamos encontrar el archivo original
          // Esto asume que el moduleloader usa extensiones estándar
          var extensions = ['.js', '.json', '.coffee', '.ts'];
          var found = false;
          for (var i = 0; i < extensions.length; i++) {
            var fullPath = path.join(options.dirname, identity + extensions[i]);
            if (fs.existsSync(fullPath)) {
              section.files[identity] = fullPath;
              found = true;
              break;
            }
          }
          // Si no lo encontramos por nombre directo (por ejemplo si tiene subcarpetas), 
          // en esta primera versión simplificada podríamos saltarlo o mejorar el mapping.
          // Sails suele aplanar modelos en la raíz de api/models.
        }
      }

      manifest.sections[sectionName] = section;

      // Asegurar que el directorio existe (ej: .tmp/)
      var dir = path.dirname(manifestPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (e) {
      // Si falla la escritura, simplemente no hay cache para la próxima
    }
  }
};
