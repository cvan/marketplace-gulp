var amdOptimize = require('amd-optimize');
var fs = require('fs');
var glob = require('glob');
var gulp = require('gulp');
var clean = require('gulp-clean');
var concat = require('gulp-concat');
var eventStream = require('event-stream');
var gulpFile = require('gulp-file');
var ignore = require('gulp-ignore');
var insert = require("gulp-insert");
var install = require("gulp-install");
var order = require('gulp-order');
var minifyCSS = require('gulp-minify-css');
var rename = require('gulp-rename');
var stylus = require('gulp-stylus');
var uglify = require('gulp-uglify');
var gulpUtil = require('gulp-util');
var webserver = require('gulp-webserver');
var mergeStream = require('merge-stream');
var path = require('path');
var requireDir = require('require-dir');
var argv = require('yargs').argv;

var config = require('../../config');
var nunjucksBuild = require('./plugins/nunjucks-build');
var imgurlsAbsolutify = require('./plugins/imgurls-absolutify');
var imgurlsCachebust = require('./plugins/imgurls-cachebust');
var imgurlsParse = require('./plugins/imgurls-parse');
var paths = require('./paths');


requireDir('tasks');


var serveTasks = ['templates_build'];
var compiled_css = glob.sync('src/media/css/*.styl.css').length;
if (!compiled_css) {
    serveTasks.push('css_compile');
}


gulp.task('install', function(done) {
    // Bumps bower and npm dependencies.
    gulp.src(['bower.json', 'package.json'])
        .pipe(install())
        .pipe(gulpUtil.noop())  // Wait for dependencies to finish installing.
        .on('finish', function() {
            done();
        });
});


gulp.task('bower_copy', ['install'], function() {
    // Copy files from Bower into project.
    return Object.keys(config.bowerConfig).forEach(function(source) {
        var dest = config.bowerConfig[source];
        gulp.src(paths.bower + source)
            .pipe(gulp.dest(dest));
    });
});


gulp.task('require_config', ['install'], function() {
    // Build a require.js file that contains a convenience call to
    // require.config that sets up some pre-known paths.
    return gulp.src(paths.require)
        .pipe(insert.append(config.inlineRequireConfig))
        .pipe(gulp.dest(config.LIB_DEST_PATH));
});


gulp.task('templates_build', function() {
    // Build Nunjucks templates into a templates.js file.
    return gulp.src(paths.html)
        .pipe(nunjucksBuild())
        .pipe(concat('templates.js'))
        .pipe(insert.prepend(
            '(function() {\n' +
            'var templates = {};\n'))
        .pipe(insert.append(
            'define("templates", ["nunjucks", "helpers"], function(nunjucks) {\n' +
            '    nunjucks.env = new nunjucks.Environment([], {autoescape: true});\n' +
            '    nunjucks.env.cache = nunjucks.templates = templates;\n' +
            '    console.log("Templates loaded");\n' +
            '    return nunjucks;\n' +
            '});\n' +
            '})();'
        ))
        .pipe(gulp.dest('src'));
});


gulp.task('css_compile', function() {
    // Compile .styl files into .styl.css files.
    return gulp.src(paths.styl)
        .pipe(stylus())
        .pipe(rename(function(path) {
            path.extname = '.styl.css';
        }))
        .pipe(gulp.dest(config.CSS_DEST_PATH));
});


gulp.task('css_bundles', ['css_compile'], function() {
    // Read the config and build specified CSS bundles (like for splash.css).
    var streams = [];

    Object.keys(config.cssBundles || []).forEach(function(bundle) {
        streams.push(gulp.src(config.CSS_DEST_PATH + config.cssBundles[bundle])
            .pipe(concat(bundle))
            .pipe(minifyCSS())
            .pipe(gulp.dest(config.CSS_DEST_PATH))
        );
    });

    // Yes, cross the streams.
    if (streams) {
        return mergeStream.apply(this, streams);
    }
});


gulp.task('css_build', ['css_bundles', 'css_compile'], function() {
    // Bundle and minify all the CSS into include.css.
    var excludes = Object.keys(config.cssBundles || []).map(function(bundle) {
        // Exclude generated bundles if any specified in the config.
        return bundle;
    });
    // Exclude previously generated builds.
    excludes.push(paths.include_css);
    // Exclude from project config.
    if (config.cssExcludes) {
        excludes = excludes.concat(config.cssExcludes);
    }
    excludes = excludes.map(function(css) { return '!' + config.CSS_DEST_PATH + css; });

    // Determine which CSS files and which order to concat through index.html.
    var css_files = [];
    var data = fs.readFileSync(path.resolve('src', 'index.html'));
    data = data.toString();
    var css_pattern = new RegExp('href="/media/css/(.+.css)"', 'g');
    while (match = css_pattern.exec(data)) {
        css_files.push(match[1]);
    }
    css_src = css_files.map(function(css) {
        return config.CSS_DEST_PATH + css;
    });

    return gulp.src(css_src.concat(excludes))
        .pipe(stylus({compress: true}))
        .pipe(imgurlsCachebust())
        .pipe(minifyCSS())
        .pipe(order(css_files,
                    {base: config.CSS_DEST_PATH}))
        .pipe(concat(paths.include_css))
        .pipe(gulp.dest(config.CSS_DEST_PATH));
});


gulp.task('imgurls_write', ['css_build'], function() {
    // imgurls.txt is a list of cachebusted img URLs that is used by Zamboni
    // to generate the appcache manifest.
    return gulp.src(config.CSS_DEST_PATH + paths.include_css)
        .pipe(imgurlsAbsolutify())
        .pipe(imgurlsParse())
        .pipe(rename('imgurls.txt'))
        .pipe(gulp.dest('src/media'));
});


gulp.task('buildID_write', function() {
    // Writes build ID to src/media/build_id.txt.
    var buildID = new Date().getTime().toString();
    return gulpFile('build_id.txt', buildID)
        .pipe(gulp.dest('src/media'));
});


gulp.task('js_build', ['templates_build'], function() {
    // Uses the AMD optimizer to bundle our JS modules.
    // Will read our RequireJS config to handle shims, paths, and name
    // anonymous modules.
    // Traces all modules and outputs them in the correct order.
    return eventStream.merge(
        // Almond loader.
        gulp.src(paths.almond),
        // JS bundle.
        gulp.src(paths.js)
            .pipe(amdOptimize('main', {
                baseUrl: config.JS_DEST_PATH,
                findNestedDependencies: true,
                paths: config.requireConfig.paths,
                shim: config.requireConfig.shim,
                wrapShim: true
            }))
            .pipe(concat(paths.include_js)),
        // Init script.
        gulp.src(paths.init)
    )
        .pipe(order(['**/almond.js', '**/include.js', '**/init.js']))
        .pipe(uglify())
        .pipe(concat(paths.include_js))
        .pipe(gulp.dest(config.JS_DEST_PATH));
});


gulp.task('serve', serveTasks, function() {
    // template -- template to serve (e.g., index (default), app, server).
    // port -- server port, defaults to config port or 8675.
    return gulp.src(['src'])
        .pipe(webserver({
            fallback: argv.template || 'index' + '.html',
            livereload: true,
            port: argv.port || process.env.PORT || config.PORT || 8675
        }));
});


gulp.task('clean', function() {
    return gulp.src([
        config.CSS_DEST_PATH + 'splash.css',
        config.CSS_DEST_PATH + paths.include_css,
        config.JS_DEST_PATH + paths.include_js,
        paths.styl_compiled,
        '_tmp',
        'src/locales',
        'src/media/locales',
        'src/media/build_id.txt',
        'src/media/imgurls.txt',
        'src/templates.js'
    ], {read: false})
        .pipe(clean({force: true}));
});


gulp.task('watch', function() {
    // Watch and recompile on change.
    // Note: does not detect new and deleted files while running.
    gulp.watch(paths.html, ['templates_build']);
    gulp.watch(paths.styl, ['css_compile']);
});


gulp.task('default', ['watch', 'serve']);
gulp.task('update', ['bower_copy', 'require_config']);
gulp.task('build', ['buildID_write', 'css_build', 'js_build',
                    'templates_build', 'imgurls_write']);


module.exports = {
    paths: paths
};
