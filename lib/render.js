/*!
 * connect-render - lib/render.js
 * Copyright(c) 2012 - 2014 fengmk2 <fengmk2@gmail.com>
 * MIT Licensed
 */

/**
 * Module dependencies.
 */

var fs = require('fs');
var path = require('path');
var http = require('http');
var vm = require('vm');
var ejs = require('ejs');
var filters = require('./filters');

var settings = {
  root: __dirname + '/views',
  cache: true,
  layout: 'layout.html',
  viewExt: '', // view default extname
  _filters: {},
  open: ejs.open || "<%",
  close: ejs.close || "%>"
};

for (var k in filters) {
  settings._filters[k] = filters[k];
}

var cache = {};

function _render_tpl(fn, options, callback) {
  var str;
  try {
    str = options.scope ? fn.call(options.scope, options) :  fn(options);
  } catch (err) {
    return callback(err);
  }
  callback(null, str);
}

var reg_meta = /[\\\^$*+?{}.()|\[\]]/g;
var PARTIAL_PATTERN_RE;

/**
 * add support for <%- partial('view') %> function
 * rather than realtime compiling, this implemention simply statically 'include' the partial view file
 *
 * @param {String} data
 * @param {String} [viewname] view name for partial loop check.
 * @return {String}
 */
function partial(data, viewname, options) {
  return data.replace(PARTIAL_PATTERN_RE, function (all, view) {
    // get view name
    var script = vm.createScript(view, 'myfile.vm');
    view = script.runInNewContext(options);
    if (view === viewname) {
      return "";
    } else {
      var name = view;
      if (settings.viewExt) {
        name += settings.viewExt;
      }
      var viewpath = path.join(settings.root, name);
      var tpl = '';
      try {
        tpl = fs.readFileSync(viewpath, 'utf8');
      } catch (e) {
        console.error("[%s][connect-render] Error: cannot load view partial %s\n%s", new Date(), viewpath, e.stack);
        return "";
      }
      return partial(tpl, view, options);
    }
  });
}

function _render(view, options, callback) {
  if (settings.viewExt) {
    view += settings.viewExt;
  }
  var viewpath = path.join(settings.root, view);
  var fn = settings.cache && cache[view];
  if (fn) {
    return _render_tpl(fn, options, callback);
  }
  // read template data from view file
  fs.readFile(viewpath, 'utf8', function (err, data) {
    if (err) {
      return callback(err);
    }
    var tpl = partial(data, undefined, options);
    // fn = ejs.compile(tpl, {filename: viewpath, compileDebug: true, debug: true, _with: settings._with});
    fn = ejs.compile(tpl, {
      filename: viewpath,
      _with: settings._with,
      open: settings.open,
      close: settings.close
    });
    if (settings.cache) {
      cache[view] = fn;
    }
    _render_tpl(fn, options, callback);
  });
}

function send(res, str) {
  var buf = new Buffer(str);
  res.charset = res.charset || 'utf-8';
  var contentType = res.getHeader('Content-Type') || 'text/html';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
}

/**
 * Render the view fill with options
 *
 * @param {String} view, view name.
 * @param {Object} [options=null]
 *  - {Boolean} layout, use layout or not, default is `true`.
 * @return {HttpServerResponse} this
 */
function render(view, options) {
  var self = this;
  options = options || {};

  for (var name in settings._filters) {
    options[name] = settings._filters[name];
  }

  if (settings.helpers) {
    for (var k in settings.helpers) {
      var helper = settings.helpers[k];
      if (typeof helper === 'function') {
        helper = helper(self.req, self);
      }
      if (!options.hasOwnProperty(k)) {
        options[k] = helper;
      }
    }
  }

  if (settings.filters) {
    for (var name in settings.filters) {
      options[name] = settings.filters[name];
    }
  }

  // add request to options
  if (!options.request) {
    options.request = self.req;
  }
  // render view template
  _render(view, options, function (err, str) {
    if (err) {
      return self.req.next(err);
    }
    var layout = typeof options.layout === 'string' ? options.layout : settings.layout;
    if (options.layout === false || !layout) {
      return send(self, str);
    }
    // render layout template, add view str to layout's locals.body;
    options.body = str;
    _render(layout, options, function (err, str) {
      if (err) {
        return self.req.next(err);
      }
      send(self, str);
    });
  });
  return this;
}

/**
 * connect-render: Template Render helper for connect
 *
 * Use case:
 *
 * var render = require('connect-render');
 * var connect = require('connect');
 *
 * connect(
 *   render({
 *     root: __dirname + '/views',
 *     cache: true, // must set `true` in production env
 *     layout: 'layout.html', // or false for no layout
 *     helpers: {
 *       config: config,
 *       sitename: 'NodeBlog Engine',
 *       _csrf: function (req, res) {
 *         return req.session ? req.session._csrf : "";
 *       },
 *     }
 *   });
 * );
 *
 * res.render('index.html', { title: 'Index Page', items: items });
 *
 * // no layout
 * res.render('blue.html', { items: items, layout: false });
 *
 * @param {Object} [options={}] render options.
 *  - {String} layout, layout name, default is `'layout.html'`.
 *    Set `layout=''` or `layout=false` meaning no layout.
 *  - {String} root, view files root dir.
 *  - {Boolean} cache, cache view content or not, default is `true`.
 *    Must set `cache = true` on production.
 *  - {String} viewExt, view file extname, default is `''`.
 *  - {Object} [filters={}]
 *  - {Object} [helpers={}]
 * @return {Function} render middleware for `connect`
 */
function middleware(options) {
  options = options || {};
  for (var k in options) {
    settings[k] = options[k];
  }
  // set the tag format
  PARTIAL_PATTERN_RE = new RegExp(settings.open.replace(reg_meta, "\\$&") +
  "[-=]\\s*partial\\((.+)\\)\\s*" + settings.close.replace(reg_meta, "\\$&"), 'g');
  return function (req, res, next) {
    req.next = next;
    if (!res.req) {
      res.req = req;
    }
    res.render = render;
    next();
  };
}

module.exports = middleware;
