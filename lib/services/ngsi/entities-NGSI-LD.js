/*
 * Copyright 2020 Telefonica Investigación y Desarrollo, S.A.U
 *
 * This file is part of fiware-iotagent-lib
 *
 * fiware-iotagent-lib is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * fiware-iotagent-lib is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public
 * License along with fiware-iotagent-lib.
 * If not, see http://www.gnu.org/licenses/.
 *
 * For those usages not covered by the GNU Affero General Public License
 * please contact with::daniel.moranjimenez@telefonica.com
 *
 * Modified by: Jason Fox - FIWARE Foundation
 */

const request = require('request');
const statsService = require('./../stats/statsRegistry');
const async = require('async');
const apply = async.apply;
const alarms = require('../common/alarmManagement');
const errors = require('../../errors');
const utils = require('../northBound/restUtils');
const config = require('../../commonConfig');
const constants = require('../../constants');
const moment = require('moment-timezone');
const logger = require('logops');
const _ = require('underscore');
const context = {
    op: 'IoTAgentNGSI.Entities-LD'
};
const NGSIv2 = require('./entities-NGSI-v2');
const NGSIUtils = require('./ngsiUtils');
const { json } = require('body-parser');

const NGSI_LD_NULL = { '@type': 'Intangible', '@value': null };
const NGSI_LD_URN = 'urn:ngsi-ld:';

/**
 * Determines if a value is a number - Not a Number replaced by Null
 *
 * @param      {String}   value       Value to be analyzed
 * @return     {Number}
 */
function valueOfOrNull(value) {
    return isNaN(value) ? NGSI_LD_NULL : value;
}

/**
 * Determines if a value is a number - Not a Number replaced by Null
 *
 * @param      {String}   value       Value to be analyzed
 * @return     {Number}
 */
function valueOfOrDefault(value, defaultValue) {
    return isNaN(value) ? defaultValue : value;
}

/**
 * @param      {String/Array}   value       Comma separated list or array of values
 * @return     {Array}                      Array of Lat/Lngs for use as GeoJSON
 */
function splitLngLat(value) {
    const lngLats = typeof value === 'string' || value instanceof String ? value.split(',') : value;
    lngLats.forEach((element, index, lngLats) => {
        if (Array.isArray(element)) {
            lngLats[index] = splitLngLat(element);
        } else if ((typeof element === 'string' || element instanceof String) && element.includes(',')) {
            lngLats[index] = splitLngLat(element);
        } else {
            lngLats[index] = Number.parseFloat(element);
        }
    });
    return lngLats;
}

/**
 * @param      {String}   value       Value to be analyzed
 * @return     {Array}                split pairs of GeoJSON coordinates
 */
function getLngLats(value) {
    const lngLats = _.flatten(splitLngLat(value));
    if (lngLats.length === 2) {
        return lngLats;
    }

    if (lngLats.length % 2 !== 0) {
        logger.error(context, 'Bad attribute value type.' + 'Expecting geo-coordinates. Received:%s', value);
        throw Error();
    }
    const arr = [];
    for (let i = 0, len = lngLats.length; i < len; i = i + 2) {
        arr.push([lngLats[i], lngLats[i + 1]]);
    }
    return arr;
}

/**
 * Amends an NGSIv2 attribute to NGSI-LD format
 * All native JSON types are respected and cast as Property values
 * Relationships must be give the type relationship
 *
 * @param      {String}   attr       Attribute to be analyzed
 * @return     {Object}              an object containing the attribute in NGSI-LD
 *                                   format
 */

function convertNGSIv2ToLD(attr) {
    const obj = { type: 'Property', value: attr.value };
    switch (attr.type.toLowerCase()) {
        // Properties
        case 'property':
        case 'string':
            break;

        // Other Native JSON Types
        case 'boolean':
            obj.value = !!attr.value;
            break;
        case 'float':
            obj.value = valueOfOrDefault(Number.parseFloat(attr.value), 0);
            break;
        case 'integer':
            obj.value = valueOfOrDefault(Number.parseInt(attr.value), 0);
            break;
        case 'number':
            if (NGSIUtils.isFloat(attr.value)) {
                obj.value = valueOfOrDefault(Number.parseFloat(attr.value), 0);
            } else {
                obj.value = valueOfOrDefault(Number.parseInt(attr.value), 0);
            }
            break;

        // Temporal Properties
        case 'datetime':
            obj.value = {
                '@type': 'DateTime',
                '@value': moment.tz(attr.value, 'Etc/UTC').toISOString()
            };
            break;
        case 'date':
            obj.value = {
                '@type': 'Date',
                '@value': moment.tz(attr.value, 'Etc/UTC').format(moment.HTML5_FMT.DATE)
            };
            break;
        case 'time':
            obj.value = {
                '@type': 'Time',
                '@value': moment.tz(attr.value, 'Etc/UTC').format(moment.HTML5_FMT.TIME_SECONDS)
            };
            break;

        // GeoProperties
        case 'geoproperty':
        case 'point':
        case 'geo:point':
            obj.type = 'GeoProperty';
            obj.value = { type: 'Point', coordinates: getLngLats(attr.value) };
            break;
        case 'linestring':
        case 'geo:linestring':
            obj.type = 'GeoProperty';
            obj.value = { type: 'LineString', coordinates: getLngLats(attr.value) };
            break;
        case 'polygon':
        case 'geo:polygon':
            obj.type = 'GeoProperty';
            obj.value = { type: 'Polygon', coordinates: getLngLats(attr.value) };
            break;
        case 'multipoint':
        case 'geo:multipoint':
            obj.type = 'GeoProperty';
            obj.value = { type: 'MultiPoint', coordinates: getLngLats(attr.value) };
            break;
        case 'multilinestring':
        case 'geo:multilinestring':
            obj.type = 'GeoProperty';
            obj.value = { type: 'MultiLineString', coordinates: attr.value };
            break;
        case 'multipolygon':
        case 'geo:multipolygon':
            obj.type = 'GeoProperty';
            obj.value = { type: 'MultiPolygon', coordinates: attr.value };
            break;

        // Relationships
        case 'relationship':
            obj.type = 'Relationship';
            obj.object = attr.value;
            delete obj.value;
            break;

        default:
            obj.value = { '@type': attr.type, '@value': attr.value };
    }

    if (attr.metadata) {
        Object.keys(attr.metadata).forEach(function (key) {
            switch (key) {
                case constants.TIMESTAMP_ATTRIBUTE:
                    var timestamp = attr.metadata[key].value;
                    if (timestamp === constants.ATTRIBUTE_DEFAULT || !moment(timestamp).isValid()) {
                        obj.observedAt = constants.DATETIME_DEFAULT;
                    } else {
                        obj.observedAt = moment.tz(timestamp, 'Etc/UTC').toISOString();
                    }
                    break;
                case 'unitCode':
                    obj.unitCode = attr.metadata[key].value;
                    break;
                default:
                    obj[key] = convertNGSIv2ToLD(attr.metadata[key]);
            }
        });
        delete obj.TimeInstant;
    }
    return obj;
}

/**
 * Amends an NGSIv2 payload to NGSI-LD format
 *
 * @param      {Object}   value       JSON to be converted
 * @return     {Object}               NGSI-LD payload
 */

function formatAsNGSILD(json) {
    const obj = { '@context': config.getConfig().contextBroker.jsonLdContext.split(';') };
    Object.keys(json).forEach(function (key) {
        switch (key) {
            case 'id':
                var id = json.id;
                obj[key] = id.startsWith(NGSI_LD_URN) ? id : NGSI_LD_URN + json.type + ':' + id;
                break;
            case 'type':
                obj[key] = json[key];
                break;
            case '@context':
            case constants.TIMESTAMP_ATTRIBUTE:
                // Timestamp should not be added as a root
                // element for NSGI-LD.
                break;
            default:
                obj[key] = convertNGSIv2ToLD(json[key]);
        }
    });

    delete obj.TimeInstant;
    return obj;
}

/**
 * Generate an operation handler for NGSIv2-based operations (query and update). The handler takes care of identifiying
 * the errors and calling the appropriate callback with a success or a failure depending on how the operation ended.
 *
 * Most of the parameters are passed for debugging purposes mainly.
 *
 * @param {String} operationName        Name of the NGSI operation being performed.
 * @param {String} entityName           Name of the entity that was the target of the operation.
 * @param {Object} typeInformation      Information about the device the entity represents.
 * @param {String} token                Security token used to access the entity.
 * @param {Object} options              Object holding all the information about the HTTP request.

 * @return {Function}                  The generated handler.
 */
function generateNGSILDOperationHandler(operationName, entityName, typeInformation, token, options, callback) {
    return function (error, response, body) {
        const bodyAsString = body ? JSON.stringify(body, null, 4) : '';

        if (error) {
            logger.error(context, 'Error found executing ' + operationName + ' action in Context Broker: %s', error);

            alarms.raise(constants.ORION_ALARM, error);
            callback(error);
        } else if (body && body.orionError) {
            logger.debug(
                context,
                'Orion error found executing ' + operationName + ' action in Context Broker: %j',
                body.orionError
            );

            callback(new errors.BadRequest(body.orionError.details));
        } else if (
            response &&
            operationName === 'update' &&
            response.statusCode === 204
        ) {
            logger.debug(context, 'Received the following response from the CB: Value updated successfully\n');
            alarms.release(constants.ORION_ALARM);
            callback(null, body);
        } else if (response && operationName === 'query' && body !== undefined && response.statusCode === 200) {
            logger.debug(context, 'Received the following response from the CB:\n\n%s\n\n', bodyAsString);
            logger.debug(context, 'Value queried successfully');
            alarms.release(constants.ORION_ALARM);
            callback(null, body);
        } else if (response && operationName === 'query' && response.statusCode === 204) {
            logger.debug(context, 'Received the following response from the CB:\n\n%s\n\n', bodyAsString);

            logger.error(
                context,
                'Operation ' +
                operationName +
                ' bad status code from the CB: 204.' +
                'A query operation must always return a body'
            );
            callback(new errors.BadAnswer(response.statusCode, operationName));
        } else if (response && (response.statusCode === 403 || response.statusCode === 401)) {
            logger.debug(context, 'Access forbidden executing ' + operationName + ' operation');
            callback(
                new errors.AccessForbidden(
                    token,
                    options.headers['fiware-service'],
                    options.headers['fiware-servicepath']
                )
            );
        } else if (response && body && response.statusCode === 404) {
            logger.debug(context, 'Received the following response from the CB:\n\n%s\n\n', bodyAsString);

            logger.error(context, 'Operation ' + operationName + ' error connecting to the Context Broker: %j', body);

            const errorField = NGSIUtils.getErrorField(body);
            if (
                response.statusCode &&
                response.statusCode === 404 &&
                errorField.details.includes(typeInformation.type)
            ) {
                callback(new errors.DeviceNotFound(entityName));
            } else if (errorField.code && errorField.code === '404') {
                callback(new errors.AttributeNotFound());
            } else {
                callback(new errors.EntityGenericError(entityName, typeInformation.type, body));
            }
        } else {
            logger.debug(context, 'Unknown error executing ' + operationName + ' operation');
            if (!(body instanceof Array || body instanceof Object)) {
                body = JSON.parse(body);
            }

            callback(new errors.EntityGenericError(entityName, typeInformation.type, body, response.statusCode));
        }
    };
}

/**
 * Makes a query to the Device's entity in the context broker using NGSI-LD, with the list
 * of attributes given by the 'attributes' array.
 *
 * @param {String} entityName       Name of the entity to query.
 * @param {Array} attributes        Attribute array containing the names of the attributes to query.
 * @param {Object} typeInformation  Configuration information for the device.
 * @param {String} token            User token to identify against the PEP Proxies (optional).
 */
function sendQueryValueNgsiLD(entityName, attributes, typeInformation, token, callback) {
    let url = '/ngsi-ld/v1/entities/urn:ngsi-ld:' + typeInformation.type + ':' + entityName;

    if (attributes && attributes.length > 0) {
        url = url + '?attrs=' + attributes.join(',');
    }

    const options = NGSIUtils.createRequestObject(url, typeInformation, token);
    options.method = 'GET';
    options.json = true;

    if (!typeInformation || !typeInformation.type) {
        callback(new errors.TypeNotFound(null, entityName));
        return;
    }

    logger.debug(context, 'Querying values of the device in the Context Broker at [%s]', options.url);
    logger.debug(context, 'Using the following request:\n\n%s\n\n', JSON.stringify(options, null, 4));

    request(
        options,
        generateNGSILDOperationHandler('query', entityName, typeInformation, token, options, function (error, result) {
            if (error) {
                callback(error);
            } else {
                NGSIUtils.applyMiddlewares(NGSIUtils.queryMiddleware, result, typeInformation, callback);
            }
        })
    );
}

/**
 * Makes an update in the Device's entity in the context broker, with the values given in the 'attributes' array.
 * This array should comply to the NGSI-LD's attribute format.
 *
 * @param {String} entityId       Name of the entity to register.
 * @param {Array} attributes        Attribute array containing the values to update.
 * @param {Object} typeInformation  Configuration information for the device.
 * @param {String} token            User token to identify against the PEP Proxies (optional).
 */
function sendUpdateValueNgsiLD(entityId, attributes, typeInformation, token, callback) {
    let payload = {};

    /*var url = '/ngsi-ld/v1/entities/' + entityName + '/attrs';

    if (typeInformation.type) {
       url += '?type=' + typeInformation.type;
    }*/

    const url = '/ngsi-ld/v1/entities/';

    const options = NGSIUtils.createRequestObject(url, typeInformation, token, 'PATCH');
    options.method = 'PATCH';

    if (!typeInformation || !typeInformation.type) {
        callback(new errors.TypeNotFound(null, entityId));
        return;
    }

    payload.id = entityId;
    payload.type = typeInformation.type;

    for (let i = 0; i < attributes.length; i++) {
        if (attributes[i].name && attributes[i].type) {
            payload[attributes[i].name] = {
                value: attributes[i].value,
                type: attributes[i].type
            };
            const metadata = NGSIUtils.getMetaData(typeInformation, attributes[i].name, attributes[i].metadata);
            if (metadata) {
                payload[attributes[i].name].metadata = metadata;
            }
        } else {
            callback(new errors.BadRequest(null, entityId));
            return;
        }
    }

    payload = NGSIUtils.castJsonNativeAttributes(payload);
    async.waterfall(
        [
            apply(statsService.add, 'measureRequests', 1),
            apply(NGSIUtils.applyMiddlewares, NGSIUtils.updateMiddleware, payload, typeInformation)
        ],
        function (error, result) {
            if (error) {
                callback(error);
            } else {
                var json = {};
                if (result) {
                    logger.debug(context, 'Got result from middleware:');
                    logger.error(context, JSON.stringify(result));
                    // The payload has been transformed by multientity plugin. It is not a JSON object but an Array.
                    if (result instanceof Array) {
                        if ('timestamp' in typeInformation && typeInformation.timestamp !== undefined ?
                            typeInformation.timestamp : config.getConfig().timestamp) {
                            // jshint maxdepth:5
                            if (!utils.isTimestampedNgsi2(result)) {
                                json = NGSIv2.addTimestamp(result, typeInformation.timezone);
                                // jshint maxdepth:5
                            } else if (!utils.IsValidTimestampedNgsi2(result)) {
                                logger.error(context, 'Invalid timestamp:%s', JSON.stringify(result));
                                callback(new errors.BadTimestamp(result));
                                return;
                            }
                        }

                        json = result;
                    } else {
                        delete result.id;
                        delete result.type;
                        json = result;
                        logger.debug(context, 'typeInformation: %j', typeInformation);
                        if ('timestamp' in typeInformation && typeInformation.timestamp !== undefined ?
                            typeInformation.timestamp : config.getConfig().timestamp) {
                            if (!utils.isTimestampedNgsi2(json)) {
                                json = NGSIv2.addTimestamp(json, typeInformation.timezone);
                            } else if (!utils.IsValidTimestampedNgsi2(json)) {
                                logger.error(context, 'Invalid timestamp:%s', JSON.stringify(json));
                                callback(new errors.BadTimestamp(json));
                                return;
                            }
                        }
                    }
                } else {
                    delete payload.id;
                    delete payload.type;
                    json = payload;
                }
                // Purge object_id from entities before sent to CB
                // object_id was added by createNgsi2Entity to allow multientity
                // with duplicate attribute names.
                let att;
                logger.debug(context, 'Working with the following JSON:');
                logger.error(context, JSON.stringify(json));
                if (json) {
                    for (let entity = 0; entity < json.length; entity++) {
                        for (att in json[entity]) {
                            /*jshint camelcase: false */
                            if (json[entity][att].object_id) {
                                /*jshint camelcase: false */
                                delete json[entity][att].object_id;
                            }
                            if (json[entity][att].multi) {
                                delete json[entity][att].multi;
                            }
                        }
                    }
                } else {
                    for (att in json) {
                        /*jshint camelcase: false */
                        if (json[att].object_id) {
                            /*jshint camelcase: false */
                            delete json[att].object_id;
                        }
                        if (json[att].multi) {
                            delete json[att].multi;
                        }
                    }
                }

                try {
                    if (result instanceof Array) {
                        json = _.map(json, formatAsNGSILD);
                    } else {
                        json.id = entityId;
                        json.type = typeInformation.type;
                        json = [formatAsNGSILD(json)];
                    }
                } catch (error) {
                    return callback(new errors.BadGeocoordinates(JSON.stringify(payload)));
                }

                logger.debug(context, 'Working with the transformed JSON as NGSI-LD:');
                logger.error(context, JSON.stringify(json));
                var url = options.url;
                async.forEachSeries(json, function (entity, callback) {
                    entityId = entity.id
                    // These fields should not be sent in a PATCH payload to update attributes
                    delete entity.id
                    delete entity.type

                    if(Object.keys(entity).length <= 1){
                        logger.debug(context, 'No attributes to update for entity : %s', entityId)
                        return callback();
                    }
                    
                    options.json = entity
                    options.url = url + entityId + '/attrs';

                    logger.debug(context, 'Updating device value in the Context Broker at [%s]', options.url);
                    logger.debug(
                        context,
                        'Using the following NGSI-LD request:\n\n%s\n\n',
                        JSON.stringify(options, null, 4)
                    );
                    request(
                        options,
                        generateNGSILDOperationHandler('update', entityId, typeInformation, token, options, function (error, body) {
                            callback(error);
                        })
                    );
                }, function (error) {
                    if (error) {
                        callback(error)
                    } else {
                        callback();
                    }
                });
            }
        }
    );
}

exports.formatAsNGSILD = formatAsNGSILD;
exports.sendUpdateValue = sendUpdateValueNgsiLD;
exports.sendQueryValue = sendQueryValueNgsiLD;
