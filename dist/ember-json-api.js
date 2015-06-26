define("json-api-adapter", 
  ["exports"],
  function(__exports__) {
    "use strict";
    var get = Ember.get;

    /**
     * Keep a record of routes to resources by type.
     */

    // null prototype in es5 browsers wont allow collisions with things on the
    // global Object.prototype.
    DS._routes = Ember.create(null);

    DS.JsonApiAdapter = DS.RESTAdapter.extend({
      defaultSerializer: 'DS/jsonApi',
      /**
       * Look up routes based on top-level links.
       */
      buildURL: function(typeName, id) {
        // TODO: this basically only works in the simplest of scenarios
        var route = DS._routes[typeName];
        if (!!route) {
          var url = [];
          var host = get(this, 'host');
          var prefix = this.urlPrefix();
          var param = /\{(.*?)\}/g;

          if (id) {
            if (param.test(route)) {
              url.push(route.replace(param, id));
            } else {
              url.push(route, id);
            }
          } else {
            url.push(route.replace(param, ''));
          }

          if (prefix) { url.unshift(prefix); }

          url = url.join('/');
          if (!host && url) { url = '/' + url; }

          return url;
        }

        return this._super(typeName, id);
      },

      /**
       * Fix query URL.
       */
      findMany: function(store, type, ids, snapshots) {
        return this.ajax(this.buildURL(type.modelName, ids.join(','), snapshots, 'findMany'), 'GET');
      },

      /**
       * Cast individual record to array,
       * and match the root key to the route
       */
      createRecord: function(store, type, snapshot) {
        var data = {};

        data[this.pathForType(type.modelName)] = store.serializerFor(type.modelName).serialize(snapshot, {
          includeId: true
        });

        return this.ajax(this.buildURL(type.modelName), 'POST', {
          data: data
        });
      },

      /**
       * Cast individual record to array,
       * and match the root key to the route
       */
      updateRecord: function(store, type, snapshot) {
        var data = {};

        data[this.pathForType(type.modelName)] = store.serializerFor(type.modelName).serialize(snapshot, {
          includeId: true
        });

        return this.ajax(this.buildURL(type.modelName, snapshot.id), 'PUT', {
          data: data
        });
      },

      _tryParseErrorResponse:  function(responseText) {
        try {
          return Ember.$.parseJSON(responseText);
        } catch(e) {
          return "Something went wrong";
        }
      },

      ajaxError: function(jqXHR) {
        var error = this._super(jqXHR);
        var response;

        if (jqXHR && typeof jqXHR === 'object') {
          response = this._tryParseErrorResponse(jqXHR.responseText);
          var errors = {};

          if (response &&
              typeof response === 'object' &&
                response.errors !== undefined) {

            Ember.A(Ember.keys(response.errors)).forEach(function(key) {
              errors[Ember.String.camelize(key)] = response.errors[key];
            });
          }

          if (jqXHR.status === 422) {
            return new DS.InvalidError(errors);
          } else{
            return new ServerError(jqXHR.status, response, jqXHR);
          }
        } else {
          return error;
        }
      },

      pathForType: function(modelName) {
        return Ember.String.pluralize(Ember.String.underscore(modelName));
      }
    });

    function ServerError(status, message, xhr) {
      this.status = status;
      this.message = message;
      this.xhr = xhr;

      this.stack = new Error().stack;
    }

    ServerError.prototype = Ember.create(Error.prototype);
    ServerError.constructor = ServerError;

    DS.JsonApiAdapter.ServerError = ServerError;

    __exports__["default"] = DS.JsonApiAdapter;
  });define("json-api-serializer", 
  ["exports"],
  function(__exports__) {
    "use strict";
    var get = Ember.get;
    var isNone = Ember.isNone;

    DS.JsonApiSerializer = DS.RESTSerializer.extend({
      keyForRelationship: function(key) {
        return Ember.String.camelize(key);
      },

      keyForSnapshot: function(snapshot) {
        return snapshot.modelName;
      },
      /**
       * Patch the extractSingle method, since there are no singular records
       */
      extractSingle: function(store, primaryType, payload, recordId, requestType) {
        var primaryTypeName;
        if (this.keyForAttribute) {
          primaryTypeName = this.keyForAttribute(primaryType.modelName);
        } else {
          primaryTypeName = primaryType.modelName;
        }

        var json = {};

        for (var key in payload) {
          var typeName = Ember.String.singularize(key);
          if (typeName === primaryTypeName &&
              Ember.isArray(payload[key])) {
            json[typeName] = payload[key][0];
          } else {
            json[key] = payload[key];
          }
        }
        return this._super(store, primaryType, json, recordId, requestType);
      },

      /**
       * Flatten links
       */
       normalize: function(type, hash, prop) {
        var json = this.normalizeLinks(hash);
        return this._super(type, json, prop);
      },

      normalizeLinks: function(hash) {
        for (var key in hash) {
          if (key !== 'links') {
            var camelizedKey = Ember.String.camelize(key);
            json[camelizedKey] = hash[key];
          } else if (Ember.typeOf(hash[key]) === 'object') {
            for (var link in hash[key]) {
              var linkValue = hash[key][link];
              link = Ember.String.camelize(link);
              if (linkValue && Ember.typeOf(linkValue) === 'object' && linkValue.href) {
                json.links = json.links || {};
                json.links[link] = linkValue.href;
              } else if (linkValue && Ember.typeOf(linkValue) === 'object' && linkValue.ids) {
                json[link] = linkValue.ids;
              } else {
                json[link] = linkValue;
              }
            }
          }
        }
        return this._super(type, json, prop);
      },

      /**
       * Extract top-level "meta" & "links" before normalizing.
       */
      normalizePayload: function(payload) {
        if (payload.meta) {
          this.extractMeta(payload.meta);
          delete payload.meta;
        }
        if (payload.links) {
          this.extractLinks(payload.links);
          delete payload.links;
        }
        if (payload.linked) {
          this.extractLinked(payload.linked);
          delete payload.linked;
        }
        return payload;
      },

      /**
       * Extract top-level "linked" containing associated objects
       */
      extractLinked: function(linked) {
        var link, values, value, relation;
        var store = get(this, 'store') || this.container.lookup('store:main');

        for (link in linked) {
          values = linked[link];
          for (var i = values.length - 1; i >= 0; i--) {
            value = values[i];

            if (value.links) {
              value = this.normalizeLinks(value);
              for (relation in value.links) {
                value[relation] = value.links[relation];
              }
              delete value.links;
            }
          }
        }
        this.pushPayload(store, linked);
      },

      /**
       * Parse the top-level "links" object.
       */
      extractLinks: function(links) {
        var link, key, value, route;
        var extracted = [], linkEntry, linkKey;

        for (link in links) {
          key = link.split('.').pop();
          value = links[link];
          if (typeof value === 'string') {
            route = value;
          } else {
            key = value.type || key;
            route = value.href;
          }

          // strip base url
          if (route.substr(0, 4).toLowerCase() === 'http') {
            route = route.split('//').pop().split('/').slice(1).join('/');
          }

          // strip prefix slash
          if (route.charAt(0) === '/') {
            route = route.substr(1);
          }
          linkEntry = { };
          linkKey = Ember.String.singularize(key);
          linkEntry[linkKey] = route;
          extracted.push(linkEntry);
          DS._routes[linkKey] = route;
        }
        return extracted;
      },

      // SERIALIZATION

      /**
       * Use "links" key, remove support for polymorphic type
       */
      serializeBelongsTo: function(record, json, relationship) {
        var attr = relationship.key;
        var belongsTo = record.belongsTo(attr);

        if (isNone(belongsTo)) return;

        var type = this.keyForSnapshot(belongsTo);
        var key = this.keyForRelationship(attr);

        json.links = json.links || {};
        json.links[key] = belongsToLink(key, Ember.String.camelize(type), get(belongsTo, 'id'));
      },

      /**
       * Use "links" key
       */
      serializeHasMany: function(snapshot, json, relationship) {
        var attr = relationship.key;
        var type = this.keyForRelationship(relationship.type);
        var key = this.keyForRelationship(attr);

        if (relationship.kind === 'hasMany') {
          json.links = json.links || {};
          json.links[key] = hasManyLink(key, type, snapshot, attr);
        }
      }
    });

    function belongsToLink(key, type, value) {
      var link = value;
      if (link && key !== type) {
        link = {
          id: link,
          type: type
        };
      }
      return link;
    }

    function hasManyLink(key, type, snapshot, attr) {
      var ids;
      var link = snapshot.hasMany(attr, {ids: true}) || [];
      if (link) {
        if (ids && key !== Ember.String.pluralize(type)) {
          link = {
            ids: ids,
            type: type
          };
        }
      }
      return link;
    }

    __exports__["default"] = DS.JsonApiSerializer;
  });