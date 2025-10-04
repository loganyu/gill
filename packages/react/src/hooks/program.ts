// TODO: Replace any with inferred types.

"use client";

import {
  useMutation,
  type UseMutationOptions,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type { Address, Instruction, Signature, SolanaClient, TransactionSendingSigner } from "gill";

import { GILL_HOOK_CLIENT_KEY } from "../const.js";

type InstructionBuilder<TInput = any> = (input: TInput, config?: { programAddress: Address }) => Instruction;

type AccountFetcher<TData = any> = (rpc: SolanaClient["rpc"], address: Address, config?: any) => Promise<TData>;

type CommitmentLevel = "confirmed" | "finalized";

type SignAndSendFn = (
  instruction: Instruction,
  signer: TransactionSendingSigner,
) => Promise<string>;

type ProgramHookConfig<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
> = {
  accounts: TAccounts;
  commitment?: CommitmentLevel | null;
  instructions: TInstructions;
  programAddress: Address;
};

type UseProgramMutationInput<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TInstructionName extends keyof TInstructions,
> = Omit<
  UseMutationOptions<
    string,
    Error,
    {
      commitment?: CommitmentLevel | null;
      params: Parameters<TInstructions[TInstructionName]>[0];
      rpc: SolanaClient['rpc'];
      signAndSend: SignAndSendFn;
      signer: TransactionSendingSigner;
    }
  >,
  "mutationFn"
> & {
  commitment?: CommitmentLevel | null;
  instruction: TInstructionName;
};

type UseProgramQueryInput<
  TAccounts extends Record<string, AccountFetcher<any>>,
  TAccountName extends keyof TAccounts,
> = Omit<UseQueryOptions<Awaited<ReturnType<TAccounts[TAccountName]>>, Error>, "queryFn" | "queryKey"> & {
  account: TAccountName;
  address: Address;
  rpc: Parameters<TAccounts[TAccountName]>[0];
};

const CONFIRM_TRANSATION_MAX_RETRIES = 15;
const CONFIRM_TRANSATION_COMMITMENT_FINALIZED_MILLISECOND_DELAY = 2000;
const CONFIRM_TRANSATION_COMMITMENT_CONFIRMED_MILLISECOND_DELAY = 100;
const CONFIRM_TRANSATION_MAX_MILLISECOND_DELAY = 2000;


async function waitForConfirmation(rpc: SolanaClient['rpc'], signature: Signature, commitment: CommitmentLevel): Promise<void> {
  const initialDelay =
    commitment === "finalized"
      ? CONFIRM_TRANSATION_COMMITMENT_FINALIZED_MILLISECOND_DELAY
      : CONFIRM_TRANSATION_COMMITMENT_CONFIRMED_MILLISECOND_DELAY;
  let retryCount = 0;
  let delay = initialDelay;

  while (retryCount < CONFIRM_TRANSATION_MAX_RETRIES) {
    try {
      const response = await rpc.getSignatureStatuses([signature]).send();
      const status = response.value?.[0];

      if (status?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }

      if (status?.confirmationStatus) {
        const currentLevel = status.confirmationStatus;

        if (currentLevel === commitment || (commitment === "confirmed" && currentLevel === "finalized")) {
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.2, CONFIRM_TRANSATION_MAX_MILLISECOND_DELAY);
      retryCount++;
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.2, CONFIRM_TRANSATION_MAX_MILLISECOND_DELAY);
      retryCount++;
      if (error instanceof Error && error.message.includes("Transaction failed")) {
        throw error;
      }
    }
  }
}

export function createProgramHook<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
>(config: ProgramHookConfig<TInstructions, TAccounts>) {
  const defaultCommitment = config.commitment === undefined ? "confirmed" : config.commitment;

  function useProgramMutation<TInstructionName extends keyof TInstructions>(
    input: UseProgramMutationInput<TInstructions, TInstructionName>,
  ) {
    const queryClient = useQueryClient();
    const { instruction, commitment: mutationCommitment, ...options } = input;
    const instructionFn = config.instructions[instruction];

    return useMutation({
      ...options,
      mutationFn: async (input: {
        commitment?: CommitmentLevel;
        params: Parameters<TInstructions[TInstructionName]>[0];
        rpc: SolanaClient['rpc'];
        signAndSend: SignAndSendFn;
        signer: TransactionSendingSigner;
      }) => {
        if (!input.params) {
          throw new Error("Instruction params are required");
        }
        const { params, signer, commitment: inputCommitment, rpc, signAndSend } = input;
        const commitmentToUse = inputCommitment ?? mutationCommitment ?? defaultCommitment;
        const instruction = instructionFn(params);
        const signature = await signAndSend(instruction, signer);

        if (commitmentToUse) {
          await waitForConfirmation(rpc, signature as Signature, commitmentToUse);
        }

        await queryClient.refetchQueries({
          queryKey: [GILL_HOOK_CLIENT_KEY, config.programAddress],
        });

        return signature;
      },
    });
  }

  function useProgramQuery<TAccountName extends keyof TAccounts>(input: UseProgramQueryInput<TAccounts, TAccountName>) {
    const { account, address, rpc, ...options } = input;
    const accountFetcher = config.accounts[account];

    return useQuery({
      ...options,
      enabled: options.enabled !== false && !!address && !!rpc,
      queryFn: async () => {
        const data = await accountFetcher(rpc, address);
        return data;
      },
      queryKey: [GILL_HOOK_CLIENT_KEY, config.programAddress, account, address],
      staleTime: options.staleTime ?? 1000,
    });
  }

  return {
    useProgramMutation,
    useProgramQuery,
  };
}
