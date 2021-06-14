import { useCallback, useEffect } from 'react';
import { Proposals, ProposalType, updateImmutably, updateImmutablyCurried, useChainData } from '../../../chain-data';
import { Convenience } from '../../../generated-contracts';
import { useApi3Voting, useConvenience, usePossibleChainDataUpdate } from '../../../contracts/hooks';
import { Proposal } from '../../../chain-data';
import { isGoSuccess, go, GO_RESULT_INDEX, GO_ERROR_INDEX } from '../../../utils';
import { chunk, difference, keyBy } from 'lodash';
import { openProposalIdsSelector, proposalDetailsSelector } from '../selectors';
import { getProposals, StartVoteProposal } from './get-proposals';
import { BigNumber } from '@ethersproject/bignumber';
import { notifications } from '../../../components/notifications/notifications';
import { messages } from '../../../utils/messages';

const reloadActiveProposalsAsChunks = async (
  api3Voting: ReturnType<typeof useApi3Voting>,
  convenience: Convenience,
  userAccount: string,
  previousOpenVoteIds: ReturnType<typeof openProposalIdsSelector>,
  proposals: Proposals | null,
  onChunkLoaded: (proposals: Proposal[]) => void
) => {
  if (!api3Voting || !proposals) return;

  const types = ['primary', 'secondary'] as const;

  for (const type of types) {
    const previousVoteIds = previousOpenVoteIds[type] ?? [];
    const currentVoteIds = await convenience.getOpenVoteIds(VOTING_APP_IDS[type]);

    // All of the new vote ids are new proposals created in the latest block and we need to fetch metadata for them
    const newVoteIds = difference(currentVoteIds, previousVoteIds);
    const loadNewProposals = async () => {
      const newProposalEvents: StartVoteProposal[] = [];
      for (const id of newVoteIds) {
        const startVoteFilter = api3Voting[type].filters.StartVote(id, null, null);
        const events = (await api3Voting[type].queryFilter(startVoteFilter)).map((p) => p.args);
        newProposalEvents.push(events[0]); // There will be only one start event per voteId
      }
      // TODO: maybe chunk this as well?
      onChunkLoaded(await getProposals(api3Voting[type], userAccount, newProposalEvents, type));
    };

    // All of the old proposals have metadata already loaded, we just need to update voting state
    const oldVoteIds = difference(currentVoteIds, previousVoteIds);
    const loadOldProposals = async () => {
      const voteIdsChunks = chunk(oldVoteIds, 5); // TODO: maybe reverse the vote ids before chunking

      for (const chunkIds of voteIdsChunks) {
        const generalData = await convenience.getGeneralVoteData(VOTING_APP_IDS[type], chunkIds);
        const userData = await convenience.getUserVoteData(VOTING_APP_IDS[type], userAccount, chunkIds);

        const updatedProposals: Proposal[] = chunkIds.map((id, index) => {
          return {
            // TODO: We assume the proposal with the given id exists (and theoretically it might not)
            ...proposalDetailsSelector(proposals, type, id.toString())!,
            // NOTE: these are the the only fields that could have changed for active proposal
            yea: generalData.yea[index],
            nay: generalData.nay[index],
            executed: userData.executed[index],
          };
        });

        onChunkLoaded(updatedProposals);
      }
    };

    loadNewProposals();
    loadOldProposals();
  }
};

const VOTING_APP_IDS = {
  primary: 0,
  secondary: 1,
};

export const useLoadAllProposals = () => {
  const { setChainData, userAccount } = useChainData();

  const api3Voting = useApi3Voting();
  const convenience = useConvenience();

  const loadProposals = useCallback(async () => {
    if (!api3Voting || !convenience) return;

    // TODO: use convenience contract and refactor this to load proposals by chunks
    const loadProposals = async () => {
      const { primary, secondary } = api3Voting;
      const startVoteFilter = primary.filters.StartVote(null, null, null);
      const primaryStartVotes = (await primary.queryFilter(startVoteFilter)).map((p) => p.args);
      const secondaryStartVotes = (await secondary.queryFilter(startVoteFilter)).map((p) => p.args);

      const primaryProposals = await getProposals(primary, userAccount, primaryStartVotes, 'primary');
      const secondaryProposals = await getProposals(secondary, userAccount, secondaryStartVotes, 'secondary');

      return {
        primary: keyBy(primaryProposals, 'voteId'),
        secondary: keyBy(secondaryProposals, 'voteId'),
      };
    };

    const goResponse = await go(loadProposals());
    if (isGoSuccess(goResponse)) {
      const proposals = goResponse[GO_RESULT_INDEX];

      setChainData('Load proposals', {
        proposals: {
          ...proposals,
        },
      });
    } else {
      // TODO: error handling
      console.error('Unable to load proposals', goResponse[GO_ERROR_INDEX]);
    }
  }, [api3Voting, convenience, userAccount, setChainData]);

  useEffect(() => {
    loadProposals();
  }, [loadProposals]);
};

export const useReloadActiveProposalsOnMinedBlock = () => {
  const { setChainData, userAccount, proposals } = useChainData();

  const api3Voting = useApi3Voting();
  const convenience = useConvenience();

  const reloadActiveProposals = useCallback(async () => {
    if (!api3Voting || !convenience) return;

    const loadProposals = async () => {
      const oldActiveProposalIds = openProposalIdsSelector(proposals);

      const updateState = (loadedChunk: Proposal[]) =>
        setChainData('(Re)load active proposals after loaded chunk', (state) =>
          updateImmutably(state, (immutableState) => {
            const proposals = immutableState.proposals;
            if (!proposals) return immutableState; // NOTE: This shouldn't happen

            loadedChunk.forEach((proposal) => {
              proposals.primary[proposal.voteId.toString()] = proposal;
            });
          })
        );

      // TODO: maybe just inline this function?
      return reloadActiveProposalsAsChunks(
        api3Voting,
        convenience,
        userAccount,
        oldActiveProposalIds,
        proposals,
        updateState
      );
    };

    const goResponse = await go(loadProposals());
    if (!isGoSuccess(goResponse)) {
      // TODO: error handling
      console.error('Unable to reload active proposals', goResponse[GO_ERROR_INDEX]);
    }
  }, [api3Voting, convenience, userAccount, setChainData, proposals]);

  // Ensure that the proposals are up to date with blockchain
  usePossibleChainDataUpdate(reloadActiveProposals);
};

export const useLoadProposalsByIds = (type: ProposalType, ids: BigNumber[]) => {
  const api3Voting = useApi3Voting();
  const { userAccount, setChainData } = useChainData();

  const loadProposalsByIds = useCallback(async () => {
    if (!api3Voting) return;

    const votingApp = api3Voting[type];
    const startVoteFilters = ids.map((id) => votingApp.filters.StartVote(id, null, null));
    const startVotePromises = startVoteFilters.map((filter) => votingApp.queryFilter(filter));

    const goStartVoteFilters = await go(Promise.all(startVotePromises));
    if (!isGoSuccess(goStartVoteFilters)) {
      notifications.error(messages.FAILED_TO_LOAD_PROPOSALS);
      return;
    }
    const startVotes: StartVoteProposal[] = goStartVoteFilters[GO_RESULT_INDEX].map((logs) => logs[0].args).map(
      (log) => ({
        // Removing ethers array-ish response format
        creator: log.creator,
        metadata: log.metadata,
        voteId: log.voteId,
      })
    );

    const loadedProposals = await getProposals(votingApp, userAccount, startVotes, type);
    setChainData(
      'Load proposals by ids',
      updateImmutablyCurried((state) => {
        if (!state.proposals) {
          state.proposals = { primary: {}, secondary: {} };
        }

        for (const proposal of loadedProposals) {
          state.proposals[type][proposal.voteId.toString()] = proposal;
        }
      })
    );
  }, [api3Voting, userAccount, setChainData, type, ids]);

  useEffect(() => {
    loadProposalsByIds();
  }, [loadProposalsByIds]);
};
