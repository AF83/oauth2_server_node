/* 
 * This implements a OAuth2 server methods, as specified at:
 *  http://tools.ietf.org/html/draft-ietf-oauth-v2-10
 *
 * Only features the "web server" schema: 
 *  http://tools.ietf.org/html/draft-ietf-oauth-v2-10#section-1.4.1
 *
 * Terminology:
 *  http://tools.ietf.org/html/draft-ietf-oauth-v2-10#section-1.2
 *
 */

[ 'nodetk/src'
].forEach(function(libpath) {
  require.paths.unshift(__dirname + '/../vendors/' + libpath);
});

var URL = require('url')
  , querystring = require('querystring')
  
  , randomString = require('nodetk/random_str').randomString
  , serializer = require('nodetk/serializer')
  , tools = require('nodetk/server_tools')
  
  , oauth2 = require('./common')
  ;


var SERVER = exports;
// To be set by connect middleware: SERVER.RFactory, SERVER.authentication

SERVER.oauth_error = function(res, type, id) {
  /* Render a particula error.
   *
   * Arguments:
   *  - res
   *  - type: the class of the error ('eua' or 'oat').
   *  - id: the id of the error (invalid_request, invalid_client...).
   */
  res.writeHead(400, {'Content-Type': 'text/plain'});
  res.end(JSON.stringify({error: {
    type: 'OAuthException',
    message: id + ': ' + oauth2.ERRORS[type][id],
  }}));
};


var unknown_error = exports.unknown_error = function(res, err) {
  /* To call when an unknown error happens (server error).
   */
  // console.log(err.message);
  // console.log(err.stack);
  tools.server_error(res, err);
};


// Parameters we must/can have in different kinds of requests:
var PARAMS = exports.PARAMS = {
  eua: { // eua = end user authorization
    mandatory: ['client_id', 'response_type', 'redirect_uri'],
    optional: ['state', 'scope'],
    // possible values for response_type param:
    response_types: {'token': 1, 'code': 1, 'code_and_token': 1},
  },

  oat: { // oat = Obtaining an access token
    mandatory: ['grant_type', 'client_id', 'code', 'redirect_uri'],
    // client_secret might be provided with the 'Authorization: Basic ...' header
    optional: ['scope', 'client_secret'],
  },
};
PARAMS.eua.all = PARAMS.eua.mandatory.concat(PARAMS.eua.optional);


exports.send_grant = function(res, R, user_id, client_data, additional_info) {
  /* Create a grant and send it to the user.
   * The code sent is of the form 'grand.id|grant.code'.
   *
   * Arguments:
   *  - req
   *  - res
   *  - R: rest-mongo instance
   *  - user_id: id of the user
   *  - client_data: hash, data about the client:
   *      - client_id
   *      - redirect_uri
   *      - state: str, optional, if given, will be sent with the grant.
   *  - additional_info: optional hash, anything you want to be stored with
   *    the grant.
   *
   */
  var grant = new R.Grant({
    client_id: client_data.client_id,
    time: Date.now(),
    user_id: user_id,
    code: randomString(128),
  });
  if(additional_info) grant.additional_info = additional_info;
  grant.save(function() {
    var qs = {code: grant.id + '|' + grant.code};
    if(client_data.state) qs.state = client_data.state;
    qs = querystring.stringify(qs);
    tools.redirect(res, client_data.redirect_uri + '?' + qs);
  }, function(err) {
    unknown_error(res, err);
  });
};


SERVER.valid_grant = function(R, data, callback, fallback) {
  /* Valid the grant, call callback(token|null) or fallback(err),
   * token being a JSON object.
   * If valid, the grant is invalidated and cannot be used anymore.
   *
   * To be valid, a grant must exist, not be deprecated and have the right
   * associated client.
   *
   * Arguments:
   *  - R: rest-mongo instance
   *  - data:
   *   - code: grant code given by client.
   *   - client_id: the client id giving the grant
   *  - callback: to be called with a token if the grant was valid, 
   *    or null otherwise.
   *  - fallback: to be called in case of error (an invalid grant is not 
   *    an error).
   *
   */
  var id_code = data.code.split('|');
  if(id_code.length != 2) return callback(null);
  R.Grant.get({ids: id_code[0]}, function(grant) {
    var minute_ago = Date.now() - 60000;
    if(!grant || grant.time < minute_ago || 
       grant.client_id != data.client_id || 
       grant.code != id_code[1]) return callback(null);
    var additional_info = grant.additional_info;
    // Delete the grant so that it cannot be used anymore:
    grant.delete_(function() {
      // Generate and send an access_token to the client:
      var token = {
        access_token: oauth2.create_access_token(grant.user_id, grant.client_id,
                                                 additional_info)
        // optional: expires_in, refresh_token, scope
      };
      callback(token);
    }, fallback);
  }, fallback);
};


var token_endpoint = exports.token_endpoint = function(req, res) {
  /* OAuth2 token endpoint.
   * Check the authorization_code, uri_redirect and client secret, issue a token.
   *
   * POST to config.oauth2.token_url
   *
   * Arguments:
   *  - req
   *  - res
   *
   */
  if(!req.form) return SERVER.oauth_error(res, 'oat', 'invalid_request');
  req.form.complete(function(err, params, files) {
    if(err) return SERVER.oauth_error(res, 'oat', 'invalid_request');
    var R = SERVER.RFactory();

    // We check there is no invalid_requet error:
    var error = false;
    params && PARAMS.oat.mandatory.forEach(function(param) {
      if(!params[param]) error = true;
    });
    if(error) return SERVER.oauth_error(res, 'oat', 'invalid_request');

    // We do only support 'authorization_code' as grant_type:
    if(params.grant_type != 'authorization_code')
      return SERVER.oauth_error(res, 'oat', 'unsupported_grant_type');

    // Check the client_secret is given once (and only once),
    // either by HTTP basic auth, or by client_secret parameter:
    var secret = req.headers['authorization'];
    if(secret) {
      if(params.client_secret) 
        return SERVER.oauth_error(res, 'oat', 'invalid_request');
      params.client_secret = secret.slice(6); // remove the leading 'Basic'
    }
    else if(!params.client_secret) {
      return SERVER.oauth_error(res, 'oat', 'invalid_request');
    }

    // Check the client_id exists and does have correct client_secret:
    R.Client.get({ids: params.client_id}, function(client) {
      if(!client || client.secret != params.client_secret) 
        return SERVER.oauth_error(res, 'oat', 'invalid_client');

      // Check the redirect_uri:
      // XXX: in cases we decide the redirect_uri is not binded to the client,
      // but can vary, this should be associated with the grant (and store
      // in issued_codes).
      if(client.redirect_uri != params.redirect_uri)
        return SERVER.oauth_error(res, 'oat', 'invalid_grant');

      var data = {code: params.code, client_id: client.id};
      SERVER.valid_grant(R, data, function(token) {
        if(!token) return SERVER.oauth_error(res, 'oat', 'invalid_grant');
        res.writeHead(200, { 'Content-Type': 'application/json'
                           , 'Cache-Control': 'no-store'
                           });
        res.end(JSON.stringify(token));
      }, function(err) { unknown_error(res, err) });
    }, function(err) { unknown_error(res, err) });
  });
};


SERVER.authorize = function(params, req, res) {
  /* OAuth2 Authorize function.
   * Serve an authentication form to the end user at browser.
   *
   *  This function should only be called by oauth2.authorize
   *
   * Arguments:
   *  - params: 
   *  - req
   *  - res
   *
   */
  // We check there is no invalid_requet error:
  var error = false;
  PARAMS.eua.mandatory.forEach(function(param) {
    if(!params[param]) error = true;
  });
  if(error) return SERVER.oauth_error(res, 'eua', 'invalid_request');
  if(!PARAMS.eua.response_types[params.response_type]) 
    return SERVER.oauth_error(res, 'eua', 'unsupported_response_type');

  // XXX: For now, we only support 'code' response type
  // which is used in case of a web server (Section 1.4.1 in oauth2 spec draft 10)
  // TODO: make it more compliant with the specs
  if(params.response_type != "code") {
    res.writeHead(501, {'Content-Type': 'text/plain'});
    res.end('Only code request type supported for now ' +
            '(schema 1.4.1 in oauth2 spec draft 10).');
    return;
  }

  var R = SERVER.RFactory();
  R.Client.get({ids: params.client_id}, function(client) {
    if(!client) return SERVER.oauth_error(res, 'eua', 'invalid_client');
    // Check the redirect_uri is the one we know about:
    if(client.redirect_uri != params.redirect_uri) 
      return SERVER.oauth_error(res, 'eua', 'redirect_uri_mismatch');
    // Eveything is allright, ask the user to sign in.
    SERVER.authentication.login(req, res, {
      client_id: client.id,
      client_name: client.name,
      redirect_uri: params.redirect_uri,
      state: params.state
    });
  }, function(err) { unknown_error(res, err) });
};


SERVER.authorize_endpoint = function(req, res) {
  /* OAuth2 Authorize end-point.
   * Serve an authentication form to the end user at browser.
   *
   *  GET or POST on config.oauth2.authorize_url
   *
   * Arguments:
   *  - req
   *  - res
   *
   */
  var params = URL.parse(req.url, true).query;
  if(params) return SERVER.authorize(params, req, res);
  else {
    if(!req.form) return SERVER.oauth_error(res, 'eua', 'invalid_request');
    req.form.complete(function(err, fields, files) {
      if(err) return SERVER.oauth_error(res, 'eua', 'invalid_request');
      SERVER.authorize(fields, req, res);
    });
  }
};


exports.connector = function(config, RFactory, authentication) {
  /* Returns Oauth2 server connect middleware.
   *
   * This middleware will intercept requests aiming at OAuth2 server
   * and treat them.
   *
   * Arguments:
   *  - config, hash containing:
   *    - authorize_url: end-user authorization endpoint,
   *      the URL the end-user must be redirected to to be served the 
   *      authentication form.
   *    - token_url: OAuth2 token endpoint,
   *      the URL the client will use to check the authorization_code given by
   *      user and get a token.
   *  - RFactory: RFactory object initialized whith minimal schema info
   *    (Grant and Client objects). cf. README file for more info.
   *  - authentication: module (or object) defining the following functions:
   *    * login: function to render the login page to end user in browser.
   *    * process_login: to process the credentials given by user. 
   *      This function should use the send_grant function once user is
   *      authenticated.
   *
   */
  SERVER.RFactory = RFactory;
  SERVER.authentication = authentication;
  var routes = {GET: {}, POST: {}};
  routes.GET[config.authorize_url] = 
    routes.POST[config.authorize_url] = SERVER.authorize_endpoint;
  routes.POST[config.process_login_url] = authentication.process_login;
  routes.POST[config.token_url] = token_endpoint;
  return tools.get_connector_from_str_routes(routes);
};
