//     help-esb.js

(function(root, factory) {
  'use strict';

  // Setup HelpEsb appropriately for the environment.  Dependency on net likely
  // means this only works on Node.js, but meh.
  if (typeof define === 'function' && define.amd) {
    define(['net', 'bluebird', 'uuid', 'lodash'], function(net, Promise, uuid, _) {
      root.HelpEsb = factory(exports, net, Promise, uuid, _);
    });
  } else if (typeof exports !== 'undefined') {
    factory(exports, require('net'), require('bluebird'), require('uuid'), require('lodash'));
  } else {
    root.HelpEsb = factory({}, root.net, root.Promise, root.uuid, root._);
  }
}(this, function(HelpEsb, net, Promise, uuid, _) {
  'use strict';

  // ## HelpEsb.Client

  // ### HelpEsb.Client *constructor*
  // The client connects to the ESB running on the given host/port.  You will
  // need to **login** and **subscribe** before doing anything over the
  // connection.
  //
  //     var client = Esb.Client('example.com', 1234);
  //     client.login('clientName');
  //     client.subscribe('subscriptionChannel1');
  HelpEsb.Client = function(host, port) {
    // This uses the basic socket connection to the ESB.  We are forcing utf-8
    // here as we shouldn't really use anything else.
    this._socket = Promise.promisifyAll(
      net.createConnection({host: host, port: port})
    );
    this._socket.setEncoding('utf-8');

    // We can't send anything over the socket until we have a connection.  We
    // immediately initiate the connection and save a promise for it so that
    // the client ensures the connection exists before trying to send data.
    this._socketConnection = this._socket.onAsync('connect');

    // Handle data coming in over the socket using our special handler.
    // Because data can come in pieces, we have to keep a data buffer so that
    // we only process complete payloads.
    this._buffer = '';
    this._socket.on('data', this._handleData.bind(this));

    // Error handling is a bit simpler - we can just pass the error to the
    // user's configured error handler.
    this._socket.on('error', this._trigger.bind(this, 'error'));

    // We begin with empty handlers.
    this._handlers = {};

    // Start with empty credentials and no authentication.
    this._credentials = {};
    this._authentication = null;
  };

  // ### HelpEsb.Client.login
  // Set authentication credentials for use with the ESB.  Right now, this does
  // not actually "login" to the ESB because that behavior is combined with the
  // subscription behavior.  Once you subscribe or attempt to send a message,
  // the login will be finalized.
  //
  //     client.login('clientName');
  HelpEsb.Client.prototype.login = function(name) {
    this._credentials.name = name;
  }

  // ### HelpEsb.Client.subscribe
  // Register with the ESB and subscribe to an ESB group.  This returns a
  // [promise](https://github.com/petkaantonov/bluebird) of the send event so
  // you can do additional tasks after the subscription has been sent.  Note
  // that this currently only checks that the message was sent and so the
  // promise does not indicate that the subscription was successful on the ESB.
  //
  //     client.subscribe('a').then(function() {
  //       console.log('Subscribed!');
  //     });
  HelpEsb.Client.prototype.subscribe = function(subscription) {
    return this._authentication = this._sendRaw(this._massageOutboundPacket({
      meta: {type: 'login'},
      data: _.extend(
        this._credentials,
        {subscriptions: Array.prototype.slice.call(arguments)}
      )
    }));
  };

  // ### HelpEsb.Client.on
  // Register an event handler for the given event.  This may be called
  // multiple times to attach multiple event handlers for the same event or for
  // different ones.  They will be called in the order they are added.  The
  // events sent include: `payload`, and `error`.
  //
  //     client.on('payload', function(data) {
  //       console.log(data);
  //     });
  //     client.on('error', function(error) {
  //       console.warn(error);
  //     });
  HelpEsb.Client.prototype.on = function(name, cb) {
    // Lazily initialize the handlers
    if (typeof this._handlers[name] === 'undefined') {
      this._handlers[name] = [];
    }

    this._handlers[name].push(cb);
  };

  // ### HelpEsb.Client.send
  // Sends a payload message to the ESB with the given data.  Returns a promise
  // that,, like the `subscribe` call, is fulfilled when the message is sent,
  // but does not indicate whether the message was received by the ESB.
  //
  //     client.send('target', {id: 1234, message: 'Hello!'});
  HelpEsb.Client.prototype.send = function(group, data) {
    return this._send({meta: {type: 'sendMessage', group: group}, data: data});
  };

  // ---
  // ### Private Methods

  // Format the packet for the ESB and send it over the socket.
  HelpEsb.Client.prototype._send = function(packet) {
    return this._authenticated().then(function() {
      return this._sendRaw(this._massageOutboundPacket(packet));
    }.bind(this));
  };

  // Wait on the socket connection and once it is avaialable send the given
  // string data returning a promise of the data being sent.
  HelpEsb.Client.prototype._sendRaw = function(data) {
    return this._socketConnection.then(function() {
      return this._socket.writeAsync(data);
    }.bind(this));
  };

  // Returns the promise of authentication if the user has already subscribed,
  // otherwise it just subscribes to nothing in order to at least authenticate.
  HelpEsb.Client.prototype._authenticated = function() {
    return this._authentication || this.subscribe();
  };

  // Handle an incoming slice of data over the socket.  Split the message on
  // the newline delimiters and pass each complete packet to `_handlePacket`.
  HelpEsb.Client.prototype._handleData = function(data) {
    // Continue to append to the buffer.  The full message may not come in one
    // piece.
    this._buffer += data;
    if (this._buffer.indexOf('\n') !== -1) {
      // It is even possible that multiple packets were sent at once and so we
      // need to make sure we parse all of them.
      var packets = this._buffer.split('\n');

      // The section after the last newline (which may be empty) is kept in the
      // buffer as it belongs to the next packet.
      this._buffer = packets[packets.length - 1];

      packets.slice(0, -1).forEach(this._handlePacket.bind(this));
    }
  };

  // Handles a single packet of data.  The data is expected to be JSON, and if
  // it isn't, an error will be triggered through the event handler.
  // Otherwise, an event of the packet's "type" will be triggered with the
  // packet data being passed.
  //
  // In the future, this will also be responsible for handling "special"
  // packets like heartbeats, etc. that are kept separate from the primary
  // payload packets.
  HelpEsb.Client.prototype._handlePacket = function(packet) {
    try {
      packet = JSON.parse(packet);
    } catch (e) {
      this._trigger('error', e);
      return;
    }

    if (
      typeof packet.meta !== 'object' ||
      typeof packet.meta.type !== 'string' ||
      typeof packet.data === 'undefined'
    ) {
      this._trigger('error', 'Invalid format detected for packet', packet);
      return;
    }

    this._trigger(packet.meta.type, packet.data);
  };

  // Triggers an event of the given type, passing along the remaining arguments
  // to all handlers that have been registered for the event.
  HelpEsb.Client.prototype._trigger = function(name) {
    if (typeof this._handlers[name] === 'undefined') {
      return;
    }

    var args = Array.prototype.slice.call(arguments, 1);

    this._handlers[name].forEach(function(handler) {
      handler.call({}, args);
    });
  };

  // Process the packet to ensure it conforms to the ESB requirements.  Sets
  // the message id in the metadata for the packet if it wasn't already set.
  // JSON encodes the message.  Finally, appends a newline to the message as
  // the delimiter between messages.
  HelpEsb.Client.prototype._massageOutboundPacket = function(packet) {
    packet.meta.id = packet.meta.id || uuid.v4();

    return JSON.stringify(packet) + "\n";
  };

  return HelpEsb;
}));
