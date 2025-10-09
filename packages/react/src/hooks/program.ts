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
import { useSolanaClient } from "./client.js";

type InstructionBuilder<TInput = any> = (input: TInput, config?: { programAddress: Address }) => Instruction;

type AccountFetcher<TData = any> = (rpc: SolanaClient["rpc"], config?: any) => Promise<TData>;

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
};

const FINALIZED_DELAYS = [10000, 3000, 3000, 3000, 3000];
const CONFIRMED_DELAYS = [1500, 500, 500, 500];

async function waitForConfirmation(
  rpc: SolanaClient["rpc"],
  signature: Signature,
  commitment: CommitmentLevel,
): Promise<boolean> {
  const delays = commitment === "finalized" ? FINALIZED_DELAYS : CONFIRMED_DELAYS;

  let transactionConfirmed = false;
  for (let retryCount = 0; retryCount < delays.length; retryCount++) {
    try {
      await new Promise((resolve) => setTimeout(resolve, delays[retryCount]));

      const response = await rpc.getSignatureStatuses([signature]).send();
      const status = response.value?.[0];

      if (status?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus) {
        const currentLevel = status.confirmationStatus;
        const isConfirmed = currentLevel === commitment || (commitment === "confirmed" && currentLevel === "finalized");
        if (isConfirmed) {
          transactionConfirmed = true;
          return true;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("Transaction failed")) {
        throw error;
      }
    }
  }

  return transactionConfirmed;
}

export function createProgramHook<
  TInstructions extends Record<string, InstructionBuilder<any>>,
  TAccounts extends Record<string, AccountFetcher<any>>,
>(config: ProgramHookConfig<TInstructions, TAccounts>) {
  const defaultCommitment = config.commitment === undefined ? "confirmed" : config.commitment;
  const { rpc } = useSolanaClient();

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
        const { params, signer, commitment: inputCommitment, signAndSend } = input;
        const commitmentToUse = inputCommitment ?? mutationCommitment ?? defaultCommitment;
        const instruction = instructionFn(params);
        const signature = await signAndSend(instruction, signer);

        let confirmed;
        if (commitmentToUse) {
          confirmed = await waitForConfirmation(rpc, signature as Signature, commitmentToUse);
        }

        await queryClient.invalidateQueries({
          queryKey: [GILL_HOOK_CLIENT_KEY, config.programAddress],
        });

        if (commitmentToUse && !confirmed) {
          throw new Error(`Unable to confirm commitment level for transaction ${signature}`);
        }

        return signature;
      },
    });
  }

  function useProgramQuery<TAccountName extends keyof TAccounts>(input: UseProgramQueryInput<TAccounts, TAccountName>) {
    const { account, address, ...options } = input;
    const { rpc, urlOrMoniker } = useSolanaClient();
    const accountFetcher = config.accounts[account];

    return useQuery({
      ...options,
      enabled: options.enabled !== false && !!address && !!rpc,
      queryFn: async () => {
        const data = await accountFetcher(rpc, address);
        return data;
      },
      queryKey: [GILL_HOOK_CLIENT_KEY, config.programAddress, urlOrMoniker, account, address],
      staleTime: options.staleTime ?? 1000,
    });
  }

  return {
    useProgramMutation,
    useProgramQuery,
  };
}
