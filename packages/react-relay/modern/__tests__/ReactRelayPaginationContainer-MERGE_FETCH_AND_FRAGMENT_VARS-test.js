/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+relay
 * @format
 */

'use strict';

const React = require('React');
const ReactRelayContext = require('../ReactRelayContext');
const ReactRelayFragmentContainer = require('../ReactRelayFragmentContainer');
const ReactRelayPaginationContainer = require('../ReactRelayPaginationContainer');
const ReactTestRenderer = require('ReactTestRenderer');
const RelayModernTestUtils = require('RelayModernTestUtils');

const {createMockEnvironment} = require('RelayModernMockEnvironment');
const {
  createOperationDescriptor,
  ConnectionHandler,
  ConnectionInterface,
  RelayFeatureFlags,
} = require('relay-runtime');
const {generateAndCompile} = RelayModernTestUtils;

describe('ReactRelayPaginationContainer MERGE_FETCH_AND_FRAGMENT_VARS', () => {
  let TestChildComponent;
  let TestComponent;
  let TestChildContainer;
  let TestContainer;
  let UserFragment;
  let UserFriendFragment;
  let UserQuery;

  let environment;
  let getConnectionFromProps;
  let getVariables;
  let loadMore;
  let ownerUser1;
  let refetchConnection;
  let render;
  let variables;

  class ContextSetter extends React.Component {
    constructor(props) {
      super(props);

      this.__relayContext = {
        environment: props.environment,
        variables: props.variables,
      };

      this.state = {
        props: null,
      };
    }

    setProps(props) {
      this.setState({props});
    }
    setContext(env, vars) {
      this.__relayContext = {
        environment: env,
        variables: vars,
      };
      this.setProps({});
    }

    render() {
      let child = React.Children.only(this.props.children);
      if (this.state.props) {
        child = React.cloneElement(child, this.state.props);
      }

      return (
        <ReactRelayContext.Provider value={this.__relayContext}>
          {child}
        </ReactRelayContext.Provider>
      );
    }
  }

  beforeEach(() => {
    jest.resetModules();
    expect.extend(RelayModernTestUtils.matchers);

    RelayFeatureFlags.MERGE_FETCH_AND_FRAGMENT_VARS = true;

    environment = createMockEnvironment({
      handlerProvider: () => ConnectionHandler,
    });
    ({UserFragment, UserFriendFragment, UserQuery} = generateAndCompile(`
      query UserQuery(
        $after: ID
        $count: Int!
        $id: ID!
        $orderby: [String]
        $isViewerFriend: Boolean
      ) {
        node(id: $id) {
          id
          __typename
          ...UserFragment @arguments(isViewerFriendLocal: $isViewerFriend, orderby: $orderby)
        }
      }

      fragment UserFragment on User
        @argumentDefinitions(
          isViewerFriendLocal: {type: "Boolean", defaultValue: false}
          orderby: {type: "[String]"}
        ) {
        id
        friends(
          after: $after,
          first: $count,
          orderby: $orderby,
          isViewerFriend: $isViewerFriendLocal
        ) @connection(key: "UserFragment_friends") {
          edges {
            node {
              id
              ...UserFriendFragment @arguments(isViewerFriendLocal: $isViewerFriendLocal)
            }
          }
        }
      }

      fragment UserFriendFragment on User
        @argumentDefinitions(
          isViewerFriendLocal: {type: "Boolean", defaultValue: false}
        ) {
        id
        name @include(if: $isViewerFriendLocal)
      }
    `));

    TestChildComponent = jest.fn(() => <div />);
    TestChildContainer = ReactRelayFragmentContainer.createContainer(
      TestChildComponent,
      {user: UserFriendFragment},
    );
    render = jest.fn(props => {
      ({loadMore, refetchConnection} = props.relay);
      const edges = props.user?.friends?.edges ?? [];
      return edges.map(edge => <TestChildContainer user={edge.node} />);
    });
    variables = {
      after: null,
      count: 1,
      id: '4',
      orderby: ['name'],
      isViewerFriend: false,
    };

    getConnectionFromProps = jest.fn(props => props.user.friends);
    getVariables = jest.fn((props, {count, cursor}, fragmentVariables) => {
      return {
        ...fragmentVariables,
        id: props.user.id,
        after: cursor,
        count,
      };
    });
    TestComponent = render;
    TestComponent.displayName = 'TestComponent';
    TestContainer = ReactRelayPaginationContainer.createContainer(
      TestComponent,
      {
        user: () => UserFragment,
      },
      {
        direction: 'forward',
        getConnectionFromProps,
        getFragmentVariables: (vars, totalCount) => ({
          ...vars,
          isViewerFriendLocal: vars.isViewerFriend,
          count: totalCount,
        }),
        getVariables,
        query: UserQuery,
      },
    );

    // Pre-populate the store with data
    ownerUser1 = createOperationDescriptor(UserQuery, variables);
    environment.commitPayload(ownerUser1, {
      node: {
        id: '4',
        __typename: 'User',
        friends: {
          edges: [
            {
              cursor: 'cursor:1',
              node: {
                __typename: 'User',
                id: 'node:1',
                name: 'user:1',
              },
            },
          ],
          pageInfo: {
            endCursor: 'cursor:1',
            hasNextPage: true,
          },
        },
      },
    });
  });

  afterEach(() => {
    RelayFeatureFlags.MERGE_FETCH_AND_FRAGMENT_VARS = false;
  });

  describe('loadMore()', () => {
    beforeEach(() => {
      const userPointer = environment.lookup(ownerUser1.fragment, ownerUser1)
        .data.node;
      environment.mock.clearCache();
      ReactTestRenderer.create(
        <ContextSetter environment={environment} variables={variables}>
          <TestContainer user={userPointer} />
        </ContextSetter>,
      );
    });

    it('returns null if there are no more items to fetch', () => {
      // Simulate empty connection data
      getConnectionFromProps.mockImplementation(() => null);
      variables = {
        after: 'cursor:1',
        count: 1,
        id: '4',
      };
      expect(loadMore(1, jest.fn())).toBe(null);
      expect(environment.mock.isLoading(UserQuery, variables)).toBe(false);
    });

    it('returns null if page info fields are null', () => {
      const {PAGE_INFO, END_CURSOR, HAS_NEXT_PAGE} = ConnectionInterface.get();
      // Simulate empty connection data
      getConnectionFromProps.mockImplementation(() => ({
        edges: [],
        [PAGE_INFO]: {
          [END_CURSOR]: null,
          [HAS_NEXT_PAGE]: null,
        },
      }));
      variables = {
        after: 'cursor:1',
        count: 1,
        id: '4',
      };
      expect(loadMore(1, jest.fn())).toBe(null);
      expect(environment.mock.isLoading(UserQuery, variables)).toBe(false);
    });

    it('calls `getVariables` with props, count/cursor, and the previous variables', () => {
      loadMore(1, jest.fn());
      expect(getVariables).toBeCalledWith(
        {
          user: {
            id: '4',
            friends: {
              edges: [
                {
                  cursor: 'cursor:1',
                  node: {
                    __typename: 'User',
                    id: 'node:1',
                    __id: 'node:1',
                    __fragments: {
                      UserFriendFragment: {isViewerFriendLocal: false},
                    },
                    __fragmentOwner: ownerUser1,
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:1',
                hasNextPage: true,
              },
            },
          },
        },
        {
          count: 1,
          cursor: 'cursor:1',
        },
        {
          after: null, // fragment variable defaults to null
          count: 1,
          id: '4',
          orderby: ['name'],
          isViewerFriend: false,
          isViewerFriendLocal: false,
        },
      );
    });

    it('fetches the new variables', () => {
      variables = {
        after: 'cursor:1',
        count: 1,
        id: '4',
        orderby: ['name'],
        isViewerFriend: false,
      };
      loadMore(1, jest.fn());
      expect(environment.mock.isLoading(UserQuery, variables)).toBe(true);
    });

    it('fetches the new variables with force option', () => {
      variables = {
        after: null, // resets to `null` to refetch connection
        count: 2, // existing edges + additional edges
        id: '4',
        orderby: ['name'],
        isViewerFriend: false,
      };
      const fetchOption = {force: true};
      loadMore(1, jest.fn(), fetchOption);
      expect(
        environment.mock.isLoading(UserQuery, variables, fetchOption),
      ).toBe(true);
    });

    it('renders with the results of the new variables on success', () => {
      expect.assertions(9);
      expect(render.mock.calls.length).toBe(1);
      expect(render.mock.calls[0][0].user.friends.edges.length).toBe(1);
      loadMore(1, jest.fn());
      expect(render.mock.calls.length).toBe(1);
      TestComponent.mockClear();
      TestChildComponent.mockClear();
      environment.mock.resolve(UserQuery, {
        data: {
          node: {
            id: '4',
            __typename: 'User',
            friends: {
              edges: [
                {
                  cursor: 'cursor:2',
                  node: {
                    __typename: 'User',
                    id: 'node:2',
                    name: 'user:2',
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:2',
                hasNextPage: true,
              },
            },
          },
        },
      });

      const expectedFragmentVariables = {
        ...ownerUser1.variables,
        count: 2,
      };
      const expectedOwner = createOperationDescriptor(
        UserQuery,
        expectedFragmentVariables,
      );
      expect(render.mock.calls.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges).toEqual([
        {
          cursor: 'cursor:1',
          node: {
            __typename: 'User',
            id: 'node:1',
            __id: 'node:1',
            __fragments: {
              UserFriendFragment: {isViewerFriendLocal: false},
            },
            __fragmentOwner: expectedOwner,
          },
        },
        {
          cursor: 'cursor:2',
          node: {
            __typename: 'User',
            id: 'node:2',
            __id: 'node:2',
            __fragments: {
              UserFriendFragment: {isViewerFriendLocal: false},
            },
            __fragmentOwner: expectedOwner,
          },
        },
      ]);

      // Assert child containers are correctly rendered
      expect(TestChildComponent.mock.calls.length).toBe(3);
      TestChildComponent.mock.calls.slice(1).forEach((call, idx) => {
        const user = call[0].user;
        expect(user).toEqual({id: `node:${idx + 1}`});
      });
    });

    it('does not update variables on failure', () => {
      expect.assertions(1);
      render.mockClear();
      loadMore(1, jest.fn());
      environment.mock.reject(UserQuery, new Error('oops'));
      expect(render.mock.calls.length).toBe(0);
    });
  });

  describe('refetchConnection()', () => {
    let instance;
    let references;

    beforeEach(() => {
      references = [];
      environment.retain = () => {
        const dispose = jest.fn();
        const ref = {dispose};
        references.push(ref);
        return ref;
      };
      const userPointer = environment.lookup(ownerUser1.fragment, ownerUser1)
        .data.node;
      instance = ReactTestRenderer.create(
        <ContextSetter environment={environment} variables={variables}>
          <TestContainer user={userPointer} />
        </ContextSetter>,
      );
    });

    it('calls `getVariables` with props, totalCount, and the previous variables', () => {
      refetchConnection(1, jest.fn());
      expect(getVariables).toBeCalledWith(
        {
          user: {
            id: '4',
            friends: {
              edges: [
                {
                  cursor: 'cursor:1',
                  node: {
                    __typename: 'User',
                    id: 'node:1',
                    __id: 'node:1',
                    __fragments: {
                      UserFriendFragment: {isViewerFriendLocal: false},
                    },
                    __fragmentOwner: ownerUser1,
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:1',
                hasNextPage: true,
              },
            },
          },
        },
        {
          count: 1,
          cursor: null,
        },
        {
          after: null, // fragment variable defaults to null
          count: 1,
          id: '4',
          orderby: ['name'],
          isViewerFriend: false,
          isViewerFriendLocal: false,
        },
      );
    });

    it('fetches the new variables', () => {
      variables = {
        after: null,
        count: 1,
        id: '4',
        orderby: ['name'],
        isViewerFriend: false,
      };
      const cacheConfig = {
        force: true,
      };
      refetchConnection(1, jest.fn());
      expect(
        environment.mock.isLoading(UserQuery, variables, cacheConfig),
      ).toBe(true);
    });

    it('renders with the results of the new variables on success', () => {
      expect.assertions(6);
      expect(render.mock.calls.length).toBe(1);
      expect(render.mock.calls[0][0].user.friends.edges.length).toBe(1);
      refetchConnection(1, jest.fn());
      expect(render.mock.calls.length).toBe(1);
      environment.mock.resolve(UserQuery, {
        data: {
          node: {
            __typename: 'User',
            id: '4',
            friends: {
              edges: [
                {
                  cursor: 'cursor:2',
                  node: {
                    __typename: 'User',
                    id: 'node:2',
                    name: 'user:2',
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:2',
                hasNextPage: true,
              },
            },
          },
        },
      });
      expect(render.mock.calls.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges.length).toBe(1);
      expect(render.mock.calls[1][0]).toEqual({
        user: {
          id: '4',
          friends: {
            edges: [
              {
                cursor: 'cursor:2',
                node: {
                  __typename: 'User',
                  id: 'node:2',
                  __id: 'node:2',
                  __fragments: {
                    UserFriendFragment: {isViewerFriendLocal: false},
                  },
                  __fragmentOwner: ownerUser1,
                },
              },
            ],
            pageInfo: {
              endCursor: 'cursor:2',
              hasNextPage: true,
            },
          },
        },
        relay: {
          environment: expect.any(Object),
          hasMore: expect.any(Function),
          isLoading: expect.any(Function),
          loadMore: expect.any(Function),
          refetchConnection: expect.any(Function),
        },
      });
    });

    it('renders with the results of the new variables after components received updated props (not related to the connection)', () => {
      expect.assertions(9);
      expect(render.mock.calls.length).toBe(1);
      // By default friends list should have 1 item
      expect(render.mock.calls[0][0].user.friends.edges.length).toBe(1);
      // Let's refetch with new variables
      refetchConnection(1, jest.fn(), {
        isViewerFriend: true,
      });
      expect(render.mock.calls.length).toBe(1);
      environment.mock.resolve(UserQuery, {
        data: {
          node: {
            __typename: 'User',
            id: '4',
            friends: {
              edges: [],
              pageInfo: {
                endCursor: null,
                hasNextPage: false,
              },
            },
          },
        },
      });
      expect(render.mock.calls.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges.length).toBe(0);
      expect(render.mock.calls[1][0]).toEqual({
        user: {
          id: '4',
          friends: {
            edges: [],
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
        },
        relay: {
          environment: expect.any(Object),
          hasMore: expect.any(Function),
          isLoading: expect.any(Function),
          loadMore: expect.any(Function),
          refetchConnection: expect.any(Function),
        },
      });

      // This should trigger cWRP in the ReactRelayPaginationContainer
      instance.getInstance().setProps({
        someProp: 'test',
      });
      expect(render.mock.calls.length).toBe(3);
      expect(render.mock.calls[2][0].user.friends.edges.length).toBe(0);
      expect(render.mock.calls[2][0]).toEqual({
        user: {
          id: '4',
          friends: {
            edges: [],
            pageInfo: {
              endCursor: null,
              hasNextPage: false,
            },
          },
        },
        relay: {
          environment: expect.any(Object),
          hasMore: expect.any(Function),
          isLoading: expect.any(Function),
          loadMore: expect.any(Function),
          refetchConnection: expect.any(Function),
        },
        someProp: 'test',
      });
    });

    it('does not update variables on failure', () => {
      expect.assertions(1);
      render.mockClear();
      refetchConnection(1, jest.fn());
      environment.mock.reject(UserQuery, new Error('oops'));
      expect(render.mock.calls.length).toBe(0);
    });

    it('rerenders with the results of new overridden variables', () => {
      // expect.assertions(8);
      expect(render.mock.calls.length).toBe(1);
      expect(render.mock.calls[0][0].user.friends.edges.length).toBe(1);
      refetchConnection(1, jest.fn(), {orderby: ['last_name']});
      expect(render.mock.calls.length).toBe(1);
      TestChildComponent.mockClear();
      environment.mock.resolve(UserQuery, {
        data: {
          node: {
            id: '4',
            __typename: 'User',
            friends: {
              edges: [
                {
                  cursor: 'cursor:7',
                  node: {
                    __typename: 'User',
                    id: 'node:7',
                    name: 'user:7',
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:7',
                hasNextPage: true,
              },
            },
          },
        },
      });

      const expectedFragmentVariables = {
        ...ownerUser1.variables,
        orderby: ['last_name'],
      };
      const expectedFragmentOwner = createOperationDescriptor(
        UserQuery,
        expectedFragmentVariables,
      );

      expect(references.length).toBe(1);
      expect(references[0].dispose).not.toBeCalled();
      expect(render.mock.calls.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges.length).toBe(1);
      expect(render.mock.calls[1][0]).toEqual({
        user: {
          id: '4',
          friends: {
            edges: [
              {
                cursor: 'cursor:7',
                node: {
                  __typename: 'User',
                  id: 'node:7',
                  __id: 'node:7',
                  __fragments: {
                    UserFriendFragment: {isViewerFriendLocal: false},
                  },
                  __fragmentOwner: expectedFragmentOwner,
                },
              },
            ],
            pageInfo: {
              endCursor: 'cursor:7',
              hasNextPage: true,
            },
          },
        },
        relay: expect.any(Object),
      });

      // Assert child containers are correctly rendered
      expect(TestChildComponent.mock.calls.length).toBe(1);
      expect(TestChildComponent.mock.calls[0][0].user).toEqual({
        id: 'node:7',
      });
    });

    it('paginates with the results of new refetch/overridden variables', () => {
      refetchConnection(1, jest.fn(), {
        orderby: ['last_name'],
        isViewerFriend: true,
      });
      TestChildComponent.mockClear();
      environment.mock.resolve(UserQuery, {
        data: {
          node: {
            id: '4',
            __typename: 'User',
            friends: {
              edges: [
                {
                  cursor: 'cursor:7',
                  node: {
                    __typename: 'User',
                    id: 'node:7',
                    name: 'user:7',
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:7',
                hasNextPage: true,
              },
            },
          },
        },
      });

      let expectedFragmentVariables = {
        ...ownerUser1.variables,
        orderby: ['last_name'],
        isViewerFriend: true,
      };
      let expectedFragmentOwner = createOperationDescriptor(
        UserQuery,
        expectedFragmentVariables,
      );
      expect(render.mock.calls.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges.length).toBe(1);
      expect(render.mock.calls[1][0]).toEqual({
        user: {
          id: '4',
          friends: {
            edges: [
              {
                cursor: 'cursor:7',
                node: {
                  __typename: 'User',
                  id: 'node:7',
                  __id: 'node:7',
                  __fragments: {
                    UserFriendFragment: {isViewerFriendLocal: true},
                  },
                  __fragmentOwner: expectedFragmentOwner,
                },
              },
            ],
            pageInfo: {
              endCursor: 'cursor:7',
              hasNextPage: true,
            },
          },
        },
        relay: expect.any(Object),
      });

      // Assert child containers are correctly rendered
      expect(TestChildComponent.mock.calls.length).toBe(1);
      expect(TestChildComponent.mock.calls[0][0].user).toEqual({
        id: 'node:7',
        name: 'user:7',
      });

      loadMore(1, jest.fn());
      variables = {
        after: 'cursor:7',
        count: 1,
        orderby: ['last_name'],
        isViewerFriend: true,
        id: '4',
      };
      expect(environment.mock.isLoading(UserQuery, variables)).toBe(true);

      TestComponent.mockClear();
      TestChildComponent.mockClear();
      environment.mock.resolve(UserQuery, {
        data: {
          node: {
            id: '4',
            __typename: 'User',
            friends: {
              edges: [
                {
                  cursor: 'cursor:8',
                  node: {
                    __typename: 'User',
                    id: 'node:8',
                    name: 'user:8',
                  },
                },
              ],
              pageInfo: {
                endCursor: 'cursor:8',
                hasNextPage: true,
              },
            },
          },
        },
      });

      expectedFragmentVariables = {
        ...ownerUser1.variables,
        count: 2,
        orderby: ['last_name'],
        isViewerFriend: true,
      };
      expectedFragmentOwner = createOperationDescriptor(
        UserQuery,
        expectedFragmentVariables,
      );
      expect(render.mock.calls.length).toBe(2);
      expect(render.mock.calls[1][0].user.friends.edges.length).toBe(2);
      expect(render.mock.calls[1][0]).toEqual({
        user: {
          id: '4',
          friends: {
            edges: [
              {
                cursor: 'cursor:7',
                node: {
                  __typename: 'User',
                  id: 'node:7',
                  __id: 'node:7',
                  __fragments: {
                    UserFriendFragment: {isViewerFriendLocal: true},
                  },
                  __fragmentOwner: expectedFragmentOwner,
                },
              },
              {
                cursor: 'cursor:8',
                node: {
                  __typename: 'User',
                  id: 'node:8',
                  __id: 'node:8',
                  __fragments: {
                    UserFriendFragment: {isViewerFriendLocal: true},
                  },
                  __fragmentOwner: expectedFragmentOwner,
                },
              },
            ],
            pageInfo: {
              endCursor: 'cursor:8',
              hasNextPage: true,
            },
          },
        },
        relay: expect.any(Object),
      });

      // Assert child containers are correctly rendered
      expect(TestChildComponent.mock.calls.length).toBe(3);
      expect(TestChildComponent.mock.calls[1][0].user).toEqual({
        id: 'node:7',
        name: 'user:7',
      });
      expect(TestChildComponent.mock.calls[2][0].user).toEqual({
        id: 'node:8',
        name: 'user:8',
      });
    });
  });
});